import 'dotenv/config';
import { Bot } from 'grammy';

const token = process.env.PROBE_BOT_TOKEN;

if (!token) {
    console.error('Set PROBE_BOT_TOKEN in .env to the test bot token.');
    process.exit(1);
}

const bot = new Bot(token);

function preview(text: string | undefined): string {
    const one = (text ?? '').replace(/\s+/g, ' ').trim();
    return one.length > 100 ? `${one.slice(0, 100)}…` : one;
}

bot.on('channel_post', (ctx) => {
    const msg = ctx.channelPost;
    const lagSec = (Date.now() / 1000 - msg.date);
    const name = msg.chat.username ? `@${msg.chat.username}` : msg.chat.title;
    console.log(
        `[channel_post] ${name} id=${msg.message_id} lag=${lagSec.toFixed(1)}s ${preview(msg.text || msg.caption)}`
    );
});

async function reportMembership(username: string, botId: number): Promise<void> {
    try {
        const chat = await bot.api.getChat(`@${username}`);
        const member = await bot.api.getChatMember(chat.id, botId);
        console.log(`@${username}: ${member.status}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`@${username}: ${message}`);
    }
}

async function main(): Promise<void> {
    const me = await bot.api.getMe();
    console.log(`Listening as @${me.username}`);
    console.log('Post in a channel where this bot is an admin. Lag is seconds after the channel post time.');

    const channels = process.argv.slice(2).map(name => name.replace(/^@/, '')).filter(Boolean);
    for (const username of channels) {
        await reportMembership(username, me.id);
    }

    await bot.start({ drop_pending_updates: true });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
