import type { Alert, AlertKind } from '../core/types.ts';

const ICON: Record<AlertKind, string> = {
  new_pool: '🆕',
  dev_sell: '🚨',
  risk_high: '⛔',
  whale_buy: '🐋',
  role_change: '🔁',
  stage: '🚀',
  watched_wallet: '👀',
};

export type AlertSink = (a: Alert) => Promise<void>;

export function formatAlert(a: Alert, baseUrl?: string): string {
  const link = baseUrl ? `\n${baseUrl}/#${a.token}` : '';
  return `${ICON[a.kind]} ${a.title}\n${a.detail}${link}`;
}

/** Sends to the Telegram Bot API. Rate-limited per chat by a simple queue. */
export function telegramSink(botToken: string, chatId: string, baseUrl?: string): AlertSink {
  let chain = Promise.resolve();
  return (a) => {
    chain = chain
      .then(async () => {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: formatAlert(a, baseUrl), disable_web_page_preview: true }),
        });
        if (!res.ok) console.error(`[telegram] ${res.status} ${await res.text()}`);
        await new Promise((r) => setTimeout(r, 1_100));
      })
      .catch((err) => console.error('[telegram]', err));
    return chain;
  };
}

export function discordSink(webhookUrl: string, baseUrl?: string): AlertSink {
  let chain = Promise.resolve();
  return (a) => {
    chain = chain
      .then(async () => {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: formatAlert(a, baseUrl) }),
        });
        if (!res.ok) console.error(`[discord] ${res.status} ${await res.text()}`);
        await new Promise((r) => setTimeout(r, 600));
      })
      .catch((err) => console.error('[discord]', err));
    return chain;
  };
}

/** Only push the alert kinds worth a phone notification. */
export const PUSH_KINDS = new Set<AlertKind>(['dev_sell', 'risk_high', 'stage', 'role_change', 'watched_wallet', 'whale_buy']);
