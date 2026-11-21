// Sending Telegram messages. The real one uses the Bot API; tests use a recorder.

export type Button =
  | { text: string; app: string } // opens the Mini App at a screen, e.g. "o_12"
  | { text: string; data: string } // callback button handled by the bot
  | { text: string; url: string };

export interface OutFile {
  name: string;
  data: Uint8Array;
}

export interface Notifier {
  sendMessage(chatId: number, text: string, buttons?: Button[][]): Promise<void>;
  sendDocument(chatId: number, file: OutFile, caption?: string, buttons?: Button[][]): Promise<void>;
}

export interface SentMessage {
  chatId: number;
  text?: string;
  file?: OutFile;
  caption?: string;
  buttons?: Button[][];
}

export function recordingNotifier(): Notifier & { sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    sent,
    async sendMessage(chatId, text, buttons) {
      sent.push({ chatId, text, buttons });
    },
    async sendDocument(chatId, file, caption, buttons) {
      sent.push({ chatId, file, caption, buttons });
    },
  };
}

/** Mini App link to a screen. Uses a web_app button URL with ?startapp=… */
export function appUrl(base: string, start?: string): string {
  const root = base.replace(/\/+$/, '') + '/app/';
  return start ? `${root}?startapp=${encodeURIComponent(start)}` : root;
}

export function telegramNotifier(botToken: string, appBase: string): Notifier {
  const api = `https://api.telegram.org/bot${botToken}`;

  const keyboard = (buttons?: Button[][]) =>
    buttons?.length
      ? {
          inline_keyboard: buttons.map((row) =>
            row.map((b) =>
              'app' in b
                ? { text: b.text, web_app: { url: appUrl(appBase, b.app) } }
                : 'data' in b
                  ? { text: b.text, callback_data: b.data }
                  : { text: b.text, url: b.url },
            ),
          ),
        }
      : undefined;

  async function call(method: string, body: BodyInit, json: boolean) {
    const res = await fetch(`${api}/${method}`, {
      method: 'POST',
      headers: json ? { 'content-type': 'application/json' } : undefined,
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      // Never log the token: the URL is not printed.
      throw new Error(`Telegram ${method} failed: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  return {
    async sendMessage(chatId, text, buttons) {
      await call(
        'sendMessage',
        JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard(buttons),
        }),
        true,
      );
    },
    async sendDocument(chatId, file, caption, buttons) {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      form.set('document', new Blob([file.data as BlobPart]), file.name);
      if (caption) {
        form.set('caption', caption);
        form.set('parse_mode', 'HTML');
      }
      const kb = keyboard(buttons);
      if (kb) form.set('reply_markup', JSON.stringify(kb));
      await call('sendDocument', form, false);
    },
  };
}

/** Escape text for Telegram HTML parse mode. */
export function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
