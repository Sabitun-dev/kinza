import { useEffect, useState } from 'react';
import { Page } from '../ui/page';
import { Button, EmptyState, List, Row } from '../ui/kit';
import { confirmDialog } from '../tg';
import { ago } from '../util';
import { flushQueue, listQueue, onQueueCount, removeQueued, type QueueItem } from './queue';

/** Items saved without internet, waiting to be sent. */
export function SyncQueueScreen() {
  const [items, setItems] = useState<QueueItem[]>([]);
  useEffect(() => onQueueCount(() => listQueue().then(setItems)), []);
  return (
    <Page title="Yuborilmaganlar" subtitle="Internet qaytganda o'zi yuboriladi">
      {items.length === 0 ? (
        <EmptyState icon="check" title="Hammasi yuborilgan" />
      ) : (
        <>
          <List>
            {items.map((i) => (
              <Row
                key={i.key}
                title={i.title}
                subtitle={i.error ? `⚠️ ${i.error}` : `saqlandi ${ago(new Date(i.createdAt))}`}
                onClick={async () => {
                  if (await confirmDialog("Bu yozuvni o'chirasizmi? U serverga yuborilmaydi.")) await removeQueued(i.key);
                }}
                chevron={false}
              />
            ))}
          </List>
          <Button block icon="refresh" className="mt-4" onClick={() => flushQueue()}>
            Hozir yuborish
          </Button>
        </>
      )}
    </Page>
  );
}
