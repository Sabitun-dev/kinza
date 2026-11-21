import { useState } from 'react';
import { Badge, Button, List, Row } from '../../ui/kit';
import { Sheet } from '../../ui/sheet';
import { api } from '../../api';
import { toast } from '../../ui/toast';
import { openLink } from '../../tg';
import { ago } from '../../util';
import { t } from '@shared/i18n';

export interface DocItem {
  id: number;
  kind: string;
  number: string | null;
  revision: number;
  voided: boolean;
  createdAt: string;
}

/** PDFs: re-send to my chat, or share to the shop through Telegram. */
export function DocumentList({ docs }: { docs: DocItem[] }) {
  const [open, setOpen] = useState<DocItem | null>(null);
  const [busy, setBusy] = useState<'' | 'send' | 'share'>('');
  return (
    <>
      <List>
        {docs.map((d) => (
          <Row
            key={d.id}
            title={
              <span className={d.voided ? 'text-muted line-through' : ''}>
                {t(`docKind.${d.kind}` as never)}
                {d.number ? ` ${d.number}` : ''}
                {d.revision ? ` (tuzatish ${d.revision})` : ''}
              </span>
            }
            subtitle={ago(d.createdAt)}
            right={d.voided ? <Badge tone="danger">bekor</Badge> : <Badge tone="brand">PDF</Badge>}
            onClick={() => setOpen(d)}
          />
        ))}
      </List>
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open ? `${t(`docKind.${open.kind}` as never)} ${open.number ?? ''}` : ''}>
        <div className="space-y-3">
          <Button
            block
            icon="send"
            loading={busy === 'send'}
            onClick={async () => {
              setBusy('send');
              try {
                await api.post(`/documents/${open!.id}/send`);
                toast(t('common.sentToChat'));
                setOpen(null);
              } catch (e) {
                toast.error(e);
              } finally {
                setBusy('');
              }
            }}
          >
            Chatimga yuborish
          </Button>
          <Button
            block
            variant="secondary"
            icon="share"
            loading={busy === 'share'}
            onClick={async () => {
              setBusy('share');
              try {
                const r = await api.get(`/documents/${open!.id}/link`);
                openLink(`https://t.me/share/url?url=${encodeURIComponent(r.url)}&text=${encodeURIComponent(r.title)}`);
              } catch (e) {
                toast.error(e);
              } finally {
                setBusy('');
              }
            }}
          >
            Do'konga ulashish
          </Button>
        </div>
      </Sheet>
    </>
  );
}
