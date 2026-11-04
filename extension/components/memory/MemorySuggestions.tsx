import { Check, Lightbulb, X } from 'lucide-react';
import { Button } from '@/components/common/ui';
import { toast } from '@/components/common/toast';
import { api, describeError } from '@/services/api';
import { useChat } from '@/stores/chat';

/** Inline confirmation for automatically extracted memories ("ask before saving"). */
export function MemorySuggestions() {
  const items = useChat((s) => s.memorySuggestions);
  const dismiss = useChat((s) => s.dismissSuggestion);
  if (!items.length) return null;
  const act = async (id: string, approve: boolean) => {
    try {
      if (approve) await api.patch(`/memory/${id}`, { status: 'active' });
      else await api.del(`/memory/${id}`);
      dismiss(id);
      toast(approve ? 'Saved to memory.' : 'Discarded.', 'ok');
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };
  return (
    <div className="mx-3 mb-2 space-y-1.5 rounded-lg border border-accent/30 bg-accent/5 p-2">
      <p className="flex items-center gap-1 text-xs font-medium"><Lightbulb className="size-3.5 text-accent" /> Remember this about you?</p>
      {items.map((m) => (
        <div key={m.id} className="flex items-start gap-2 text-xs">
          <p className="min-w-0 flex-1">{m.content} {m.category && <span className="text-muted">({m.category})</span>}{m.status === 'active' && <span className="text-ok"> · saved automatically</span>}</p>
          {m.status === 'pending' ? (
            <>
              <Button size="icon" variant="ghost" aria-label="Save memory" title="Save" onClick={() => void act(m.id, true)}><Check className="size-3.5 text-ok" /></Button>
              <Button size="icon" variant="ghost" aria-label="Discard memory" title="Discard" onClick={() => void act(m.id, false)}><X className="size-3.5" /></Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => void act(m.id, false)}>Undo</Button>
          )}
        </div>
      ))}
    </div>
  );
}
