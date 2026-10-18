using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Diagnostics;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace KnowledgeFlowInstaller {
  public static class Installer {
    public static readonly string[] PayloadFiles = { "main.js", "manifest.json", "styles.css", "README.md", "THIRD-PARTY-NOTICES.md", "THIRD-PARTY-LICENSES.txt" };
    public static string ValidateVault(string path) {
      string root = Path.GetFullPath(path.Trim()).TrimEnd(Path.DirectorySeparatorChar);
      if (!Directory.Exists(root) || !Directory.Exists(Path.Combine(root, ".obsidian")))
        throw new InvalidOperationException("请选择已有的 Obsidian 笔记库文件夹，其中应包含 .obsidian 目录。请先在 Obsidian 中创建或打开笔记库。");
      if ((new DirectoryInfo(root).Attributes & FileAttributes.ReparsePoint) != 0)
        throw new InvalidOperationException("请直接选择笔记库实际目录，不要选择符号链接。");
      return root;
    }
    private static void AssertInside(string root, string path) {
      string prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
      if (!Path.GetFullPath(path).StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("安装路径超出所选笔记库。");
      string current = Path.GetFullPath(path);
      while (current.Length >= prefix.Length) {
        if ((Directory.Exists(current) || File.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
          throw new InvalidOperationException("安装目录含符号链接，请使用普通目录。");
        current = Path.GetDirectoryName(current);
        if (current == null) break;
      }
    }
    private static void CopyTree(string source, string target, bool includeLegacyBackup = true) {
      Directory.CreateDirectory(target);
      foreach (string file in Directory.GetFiles(source)) {
        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("旧插件包含符号链接，无法安全备份。");
          if (!includeLegacyBackup && Path.GetFileName(file).StartsWith("data.json.before-history-", StringComparison.Ordinal)) continue;
        File.Copy(file, Path.Combine(target, Path.GetFileName(file)), false);
      }
      foreach (string dir in Directory.GetDirectories(source)) {
        if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("旧插件包含符号链接，无法安全备份。");
          if (!includeLegacyBackup && Path.GetFileName(dir) == "migration-backup-v03") continue;
          CopyTree(dir, Path.Combine(target, Path.GetFileName(dir)), includeLegacyBackup);
      }
    }
    public static string Install(string path, bool simulateFailure) {
      string vault = ValidateVault(path);
      string plugins = Path.Combine(vault, ".obsidian", "plugins");
      string target = Path.Combine(plugins, "knowledge-flow");
      string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0,8);
      string stage = Path.Combine(plugins, ".knowledge-flow-stage-" + stamp);
      string rollback = Path.Combine(plugins, ".knowledge-flow-rollback-" + stamp);
      string backup = Path.Combine(vault, ".obsidian", "knowledge-flow-backups", stamp);
      foreach (string p in new [] { plugins, target, stage, rollback, backup }) AssertInside(vault, p);
      Directory.CreateDirectory(plugins);
      if (File.Exists(target)) throw new InvalidOperationException("插件位置被同名文件占用，未覆盖该文件。");
      bool oldMoved = false, newMoved = false;
      try {
        Directory.CreateDirectory(stage);
        if (Directory.Exists(target)) { CopyTree(target, backup, false); CopyTree(target, stage); }
        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
          if (payload == null) throw new InvalidOperationException("安装器缺少插件包，请重新下载。");
          using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read)) {
            foreach (string file in PayloadFiles) {
              ZipArchiveEntry entry = archive.GetEntry("knowledge-flow/" + file);
              if (entry == null) throw new InvalidOperationException("插件包不完整：" + file);
              string output = Path.Combine(stage, file); AssertInside(vault, output);
              using (Stream input = entry.Open()) using (Stream dest = File.Create(output)) input.CopyTo(dest);
            }
          }
        }
        if (Directory.Exists(target)) { Directory.Move(target, rollback); oldMoved = true; }
        if (simulateFailure) throw new IOException("模拟安装中断");
        Directory.Move(stage, target); newMoved = true;
        if (oldMoved) { AssertInside(vault, rollback); Directory.Delete(rollback, true); }
        return Directory.Exists(backup) ? backup : "";
      } catch {
        if (!newMoved && oldMoved && Directory.Exists(rollback) && !Directory.Exists(target)) Directory.Move(rollback, target);
        throw;
      } finally {
        if (Directory.Exists(stage)) { AssertInside(vault, stage); Directory.Delete(stage, true); }
      }
    }
    public static List<string> DiscoverVaults() {
      var paths = new List<string>();
      try {
        string config = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "obsidian", "obsidian.json");
        var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(config));
        var vaults = data["vaults"] as Dictionary<string, object>;
        if (vaults != null) foreach (object value in vaults.Values) {
          var item = value as Dictionary<string, object>;
          if (item != null && item.ContainsKey("path")) {
            string path = item["path"] as string;
            if (!String.IsNullOrEmpty(path) && Directory.Exists(Path.Combine(path, ".obsidian"))) paths.Add(path);
          }
        }
      } catch { /* Manual selection is always available. */ }
      return paths.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }
    [STAThread]
    public static int Main(string[] args) {
      if (args.Length == 2 && args[0] == "--test-install") {
        try { Install(args[1], false); return 0; } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
      }
      if (args.Length == 2 && args[0] == "--test-rollback") {
        try { Install(args[1], true); return 1; } catch { return 0; }
      }
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      Application.Run(new InstallForm()); return 0;
    }
  }
  public class InstallForm : Form {
    ComboBox vault; Button install, open; TextBox result;
    public InstallForm() {
      Text = "知流工作台 · 安装"; Font = new Font("Microsoft YaHei UI", 10);
      ClientSize = new Size(720, 490); MinimumSize = new Size(650, 490); StartPosition = FormStartPosition.CenterScreen;
      AutoScaleMode = AutoScaleMode.Dpi; BackColor = SystemColors.Window;
      var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(28), ColumnCount = 2, RowCount = 8 };
      layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
      var heading = new Label { Text = "让你的知识工作流就绪", Font = new Font(Font.FontFamily, 19, FontStyle.Bold), AutoSize = true, Margin = new Padding(0,0,0,14) };
      layout.Controls.Add(heading, 0, 0); layout.SetColumnSpan(heading, 2);
      var intro = new Label { Text = "选择已有的 Obsidian 笔记库。插件启用后，只需选择 AI 服务并填写 Key。", AutoSize = true, MaximumSize = new Size(630,0), Margin = new Padding(0,0,0,20) };
      layout.Controls.Add(intro, 0, 1); layout.SetColumnSpan(intro, 2);
      layout.Controls.Add(new Label { Text = "安装到此笔记库", AutoSize = true, Margin = new Padding(0,0,0,8) }, 0, 2);
      vault = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDown, Margin = new Padding(0,0,10,18) };
      foreach (string path in Installer.DiscoverVaults()) vault.Items.Add(path);
      if (vault.Items.Count > 0) vault.SelectedIndex = 0;
      layout.Controls.Add(vault, 0, 3);
      var browse = new Button { Text = "选择文件夹", Dock = DockStyle.Fill, Height = 34, Margin = new Padding(0,0,0,18) };
      browse.Click += delegate { using (var dialog = new FolderBrowserDialog { Description = "选择已有 Obsidian 笔记库（包含 .obsidian 目录）", ShowNewFolderButton = false }) if (dialog.ShowDialog(this) == DialogResult.OK) vault.Text = dialog.SelectedPath; };
      layout.Controls.Add(browse, 1, 3);
      var hint = new Label { Text = "升级前请关闭 Obsidian。旧插件会备份，配置、任务和笔记都会保留。\n安装器不会关闭社区插件安全限制。", AutoSize = true, MaximumSize = new Size(630,0), Margin = new Padding(0,0,0,18), ForeColor = SystemColors.GrayText };
      layout.Controls.Add(hint, 0, 4); layout.SetColumnSpan(hint, 2);
      install = new Button { Text = "安装到此笔记库", AutoSize = true, Height = 40, Padding = new Padding(12,6,12,6), Margin = new Padding(0,0,0,16) };
      install.Click += InstallClicked; layout.Controls.Add(install, 0, 5);
      result = new TextBox { ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BackColor = SystemColors.Window, BorderStyle = BorderStyle.FixedSingle, MinimumSize = new Size(0,105) };
      layout.Controls.Add(result, 0, 6); layout.SetColumnSpan(result, 2); layout.RowStyles.Clear();
      for (int i=0; i<6; i++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      layout.RowStyles.Add(new RowStyle(SizeType.Percent,100)); layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      open = new Button { Text = "打开 Obsidian", AutoSize = true, Enabled = false, Padding = new Padding(10,5,10,5), Margin = new Padding(0,16,0,0) };
      open.Click += delegate {
        try { Process.Start(new ProcessStartInfo("obsidian://open?path=" + Uri.EscapeDataString(Installer.ValidateVault(vault.Text))) { UseShellExecute = true }); }
        catch { MessageBox.Show(this, "无法自动打开 Obsidian。请先安装 Obsidian，然后手动打开此笔记库。", "打开 Obsidian"); }
      };
      layout.Controls.Add(open, 0, 7); Controls.Add(layout); AcceptButton = install;
      vault.TextChanged += delegate { open.Enabled = false; };
    }
    async void InstallClicked(object sender, EventArgs e) {
      install.Enabled = false; open.Enabled = false; vault.Enabled = false; result.Text = "正在验证目录、备份并安装…";
      string path = vault.Text;
      try {
        string backup = await System.Threading.Tasks.Task.Run(() => Installer.Install(path, false));
        result.Text = "安装完成。\r\n打开 Obsidian → 设置 → 社区插件 → 按提示允许社区插件 → 启用「知流工作台」。\r\n如果 Obsidian 已打开，请重启或重新加载插件。\r\n首次启用后，选择 AI 服务并填 Key，工作流会自动创建。" + (backup.Length > 0 ? "\r\n旧版本备份：" + backup : "");
        open.Enabled = true;
      } catch (Exception error) { result.Text = "安装未完成：" + error.Message + "\r\n请检查目录权限、关闭 Obsidian 后重试。"; }
      finally { install.Enabled = true; vault.Enabled = true; }
    }
  }
}
