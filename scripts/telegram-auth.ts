import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import input from 'input';
import { getApiCredentials } from '../src/telegramConfig';

async function main() {
    const { apiId, apiHash } = getApiCredentials();
    const session = new StringSession('');

    const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

    console.log('Telegram user auth — use a dedicated or personal account.');
    console.log('You will receive a login code in the Telegram app.\n');

    await client.start({
        phoneNumber: async () => await input.text('Phone number (international, e.g. +380...): '),
        password: async () => {
            const p = await input.text('2FA password (leave empty if none): ');
            return p || undefined;
        },
        phoneCode: async () => await input.text('Code from Telegram: '),
        onError: (err) => console.error(err)
    });

    const saved = client.session.save();
    console.log('\n--- Session string (save securely) ---\n');
    console.log(saved);
    console.log('\n--- Add to .env or docker-compose ---\n');
    console.log(`TELEGRAM_USER_SESSION=${saved}`);
    console.log('\nOr write to file and set TELEGRAM_SESSION_PATH=/database/telegram.session');

    await client.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
