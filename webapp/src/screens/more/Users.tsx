import { useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, Field, List, NumberInput, Row, Section, Segmented, SkeletonList, TextInput, Toggle } from '../../ui/kit';
import { Sheet } from '../../ui/sheet';
import { api, invalidate, useApi } from '../../api';
import { toast } from '../../ui/toast';
import { openLink, confirmDialog } from '../../tg';
import { t } from '@shared/i18n';

interface U {
  id: number;
  name: string;
  username: string | null;
  phone: string | null;
  role: 'OWNER' | 'AGENT' | 'DRIVER';
  active: boolean;
  commissionMode: 'NONE' | 'COLLECTED' | 'DELIVERED';
  commissionBp: number;
}

export function UsersScreen() {
  const { data, loading } = useApi<{ users: U[]; invites: any[] }>('/users');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [edit, setEdit] = useState<U | null>(null);

  return (
    <Page title="Xodimlar" subtitle="Agentlar va haydovchilar taklif havolasi orqali qo'shiladi">
      <Button block icon="plus" onClick={() => setInviteOpen(true)} className="mt-2">
        Taklif havolasi yaratish
      </Button>
      {loading || !data ? (
        <div className="mt-5">
          <SkeletonList rows={3} />
        </div>
      ) : (
        <>
          <Section title="Xodimlar">
            <List>
              {data.users.map((u) => (
                <Row
                  key={u.id}
                  title={u.name}
                  subtitle={[t(`roles.${u.role}` as never), u.phone, u.username && '@' + u.username].filter(Boolean).join(' · ')}
                  right={!u.active ? <Badge tone="danger">o‘chirilgan</Badge> : u.commissionBp ? <Badge tone="brand">{u.commissionBp / 100}%</Badge> : null}
                  onClick={u.role === 'OWNER' ? undefined : () => setEdit(u)}
                />
              ))}
            </List>
          </Section>
          {data.invites.length > 0 && (
            <Section title="Faol takliflar (7 kun)">
              <List>
                {data.invites.map((i) => (
                  <Row
                    key={i.id}
                    title={`${t(`roles.${i.role}` as never)}${i.note ? ' · ' + i.note : ''}`}
                    subtitle={`Muddati: ${new Date(i.expiresAt).toLocaleDateString('ru-RU')}`}
                    right={
                      <button
                        className="h-10 px-2 font-semibold text-danger"
                        onClick={async () => {
                          if (!(await confirmDialog('Taklifni bekor qilasizmi?'))) return;
                          await api.post(`/invites/${i.id}/revoke`);
                          invalidate('/users');
                        }}
                      >
                        Bekor
                      </button>
                    }
                    chevron={false}
                    onClick={() => shareInvite(i.link, i.role)}
                  />
                ))}
              </List>
            </Section>
          )}
        </>
      )}
      <InviteSheet open={inviteOpen} onClose={() => setInviteOpen(false)} />
      {edit && <UserSheet user={edit} onClose={() => setEdit(null)} />}
    </Page>
  );
}

function shareInvite(link: string, role: string) {
  const text = `KINZA DISTRO: ${t(`roles.${role}` as never)} sifatida qo'shilish uchun havolani oching (7 kun amal qiladi).`;
  openLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
}

function InviteSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [role, setRole] = useState<'AGENT' | 'DRIVER'>('AGENT');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Taklif havolasi"
      footer={
        <Button
          block
          loading={busy}
          icon="share"
          onClick={async () => {
            setBusy(true);
            try {
              const inv = await api.post('/invites', { role, note: note || undefined });
              invalidate('/users');
              shareInvite(inv.link, role);
              onClose();
            } catch (e) {
              toast.error(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Yaratish va yuborish
        </Button>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={role}
          onChange={setRole}
          options={[
            { value: 'AGENT', label: t('roles.AGENT') },
            { value: 'DRIVER', label: 'Haydovchi' },
          ]}
        />
        <Field label="Kim uchun (ixtiyoriy)">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Masalan: Akmal" />
        </Field>
        <Card className="bg-brand-soft text-[14px] text-brand shadow-none">
          Havola bir marta ishlaydi va 7 kundan keyin eskiradi. Xodim uni ochganda ilovaga kiradi.
        </Card>
      </div>
    </Sheet>
  );
}

function UserSheet({ user, onClose }: { user: U; onClose: () => void }) {
  const [active, setActive] = useState(user.active);
  const [mode, setMode] = useState(user.commissionMode);
  const [pct, setPct] = useState<number | null>(user.commissionBp / 100);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open
      onClose={onClose}
      title={user.name}
      footer={
        <Button
          block
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.patch(`/users/${user.id}`, { active, commissionMode: mode, commissionBp: Math.round((pct ?? 0) * 100) });
              invalidate('/users');
              toast(t('common.saved'));
              onClose();
            } catch (e) {
              toast.error(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('common.save')}
        </Button>
      }
    >
      <div className="space-y-4">
        <List>
          <Toggle label="Faol" hint="O'chirilsa ilovaga kira olmaydi, ma'lumotlari qoladi" checked={active} onChange={setActive} />
        </List>
        <Field label="Komissiya">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'NONE', label: "Yo'q" },
              { value: 'COLLECTED', label: 'Yig‘ilgan puldan' },
              { value: 'DELIVERED', label: 'Sotuvdan' },
            ]}
          />
        </Field>
        {mode !== 'NONE' && (
          <Field label="Foiz">
            <NumberInput value={pct} onChange={setPct} suffix="%" />
          </Field>
        )}
      </div>
    </Sheet>
  );
}
