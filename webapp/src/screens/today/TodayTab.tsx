import { Page } from '../../ui/page';
import { Card } from '../../ui/kit';
import { useSession } from '../../session';
import { formatDateHuman, localDate, WEEKDAYS_UZ, weekday } from '@shared/dates';

export function TodayTab() {
  const { user, settings } = useSession();
  const today = localDate();
  return (
    <Page title={`Salom, ${user.name.split(' ')[0]}!`} subtitle={`${WEEKDAYS_UZ[weekday(today)]}, ${formatDateHuman(today)}`}>
      <Card className="bg-brand text-brand-ink">
        <div className="text-[13px] font-bold tracking-[0.18em] text-accent">{settings.businessName}</div>
        <div className="mt-2 text-[17px]">Ilova tayyor. Bo'limlar bosqichma-bosqich qo'shilmoqda.</div>
      </Card>
    </Page>
  );
}
