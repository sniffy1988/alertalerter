import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import input from 'input';
import { getApiCredentials, persistSession } from './telegramConfig';

async function main() {
    const { apiId, apiHash } = getApiCredentials();
    const session = new StringSession('');

    const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

    console.log('Telegram user auth — use a dedicated or personal account.');
    console.log('You will receive a login code in the Telegram app.');
    if (process.env.TELEGRAM_2FA_PASSWORD) {
        console.log('Using TELEGRAM_2FA_PASSWORD from environment for 2FA.\n');
    } else {
        console.log('If your account has 2FA, you will be asked for your cloud password.\n');
    }

    await client.start({
        phoneNumber: async () => await input.text('Phone number (international, e.g. +380...): '),
        password: async (hint?: string) => {
            const fromEnv = process.env.TELEGRAM_2FA_PASSWORD?.trim();
            if (fromEnv) return fromEnv;

            const prompt = hint
                ? `2FA cloud password (hint: ${hint}): `
                : '2FA cloud password: ';
            const p = await input.text(prompt);
            if (!p) {
                throw new Error(
                    'This account has 2FA enabled. Enter your Telegram cloud password ' +
                    '(Settings → Privacy → Two-Step Verification). Empty is not allowed.'
                );
            }
            return p;
        },
        phoneCode: async () => await input.text('Code from Telegram: '),
        onError: async (err) => {
            console.error(err);
            return false;
        }
    });

    const saved = session.save();
    console.log('\n--- Session string (save securely) ---\n');
    console.log(saved);
    console.log('\n--- Add to Portainer env ---\n');
    console.log(`TELEGRAM_USER_SESSION=${saved}`);

    const sessionPath = process.env.TELEGRAM_SESSION_PATH?.trim();
    if (sessionPath) {
        if (persistSession(saved)) {
            console.log(`\nSession also written to ${sessionPath}`);
        } else {
            console.log(`\nCould not write to ${sessionPath} (path may be Docker-only).`);
            console.log('Copy TELEGRAM_USER_SESSION above into .env or Portainer env instead.');
        }
    } else {
        console.log('\nOptional: TELEGRAM_SESSION_PATH=./db_data/telegram.session (local) or /database/telegram.session (Docker)');
    }

    await client.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
