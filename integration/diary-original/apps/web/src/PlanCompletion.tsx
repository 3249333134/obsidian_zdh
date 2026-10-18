import {validationMessage} from '@diary/contracts';
import {GlassDialog} from './GlassUI';
import { useEffect, useRef, useState } from 'react';
import { captureDraftSchema, type CaptureDraft } from '@diary/contracts';
import { api, type ActionRow } from './api';
import { DraftFields } from './Capture';
import { planClock } from './planFilters';
import type { EntityContext } from './PlanEntities';

export function PlanCompletion({ row, busy, onFinish, onClose,entityContext }: { entityContext:EntityContext;row: ActionRow; busy: boolean; onFinish: (record: CaptureDraft | undefined, operationId: string) => Promise<boolean>; onClose: () => void }) {
  const [draft, setDraft] = useState(() => row.pendingRecord || captureDraftSchema.parse({ id: row.pendingFact?.id || crypto.randomUUID(), kind: 'facts', date: row.pendingFact?.date || planClock().date, time: row.pendingFact?.time || planClock().time, content: row.pendingFact?.note || `完成计划：${row.task.title}`, description: row.pendingFact?.remark || '', entities: { people: (row.task.entities || []).filter(e => e.type === 'person'), places: (row.task.entities || []).filter(e => e.type === 'place'), activities: (row.task.entities || []).filter(e => e.type === 'activity'), foods: (row.task.entities || []).filter(e => e.type === 'food') } }));
  const [supplement, setSupplement] = useState('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);
  const pending = !!row.pendingRecord || !!row.pendingFact;
  const organize = async () => {
    setParsing(true); setError('');
    try {
      const response = await api.parseCapture(supplement.trim() || `已完成计划：${row.task.title}。未补充实际结果。`, { title: row.task.title, description: row.task.description, date: draft.date, time: draft.time });
      const next = response.drafts[0];
      if (next) setDraft(old => ({ ...next, id: old.id, kind: next.kind === 'plan' ? 'facts' : next.kind, date: old.date, time: old.time, entities: Object.values(next.entities).some(group => group.length) ? next.entities : old.entities }));
    } catch (e) { setError(`${e instanceof Error ? e.message : 'AI 暂不可用'} 可继续手动编辑并保存。`); }
    finally { setParsing(false); }
  };
  useEffect(() => { if (!started.current) { started.current = true; if (!pending && !row.task.completion) void organize(); } }, []);
  return <GlassDialog className="todo-modal completion-dialog" label="完成计划，留下一条日记" busy={busy||parsing} onClose={onClose}>
    <div className="todo-modal-header"><h3>完成计划，留下一条日记</h3><p>实际发生时间默认为现在，与计划时间分开记录。</p><strong>{row.task.title}</strong>{row.task.description && <p>原计划说明：{row.task.description}</p>}</div>
    <div className="todo-modal-body">
      {!pending && !row.task.completion && <><label className="field">实际做了什么／结果补充<textarea rows={3} value={supplement} disabled={parsing || busy} onChange={e => { setSupplement(e.target.value); setDraft(d => ({ ...d, content: e.target.value || `完成计划：${row.task.title}` })); }} placeholder="只记录实际发生的内容，不把目标当作成果。" /></label><button className="quiet-button" disabled={parsing || busy} onClick={() => void organize()}>{parsing ? '正在整理…' : '重新让 AI 整理'}</button></>}
      {error && <p role="alert">{error}</p>}
      {row.task.completion ? <p>已有关联日记，请在计划卡片中查看原记录。本次仅更新完成状态。</p> : <DraftFields entityContext={entityContext} draft={draft} diaryOnly disabled={busy || parsing || pending} onChange={setDraft} />}
      {pending && <p>上次日记已写入，将恢复计划关联，不重复创建。</p>}
    </div>
    <div className="todo-modal-footer"><button className="quiet-button" disabled={busy || parsing} onClick={onClose}>取消</button><button className="quiet-button" disabled={busy || parsing || pending} onClick={() => void onFinish(undefined, draft.id)}>仅完成</button>{!row.task.completion && <button className="save-button" disabled={busy || parsing || !draft.content.trim() || !draft.date || draft.needsReview} onClick={() => void onFinish(draft, draft.id)}>完成并记入日记</button>}</div>
  </GlassDialog>;
}
