import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import prisma from './db';
import { logger } from './logger';
import { t, Locale } from './i18n';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN must be provided!');
}

export const bot = new Bot(token);

// 1. Register commands with Telegram (Universal command list)
bot.api.setMyCommands([
    { command: "start", description: "Open main menu" },
    { command: "subscribedto", description: "Manage subscriptions" },
    { command: "settings", description: "Open settings" },
    { command: "me", description: "View profile" },
    { command: "language", description: "Change language" },
    { command: "rules", description: "List filter rules (Admin only)" },
    { command: "hit", description: "Add keyword (Usage: /hit phrase) (Admin only)" },
    { command: "miss", description: "Add exclusion (Usage: /miss phrase) (Admin only)" },
    { command: "del", description: "Delete rule (Usage: /del ID) (Admin only)" },
    { command: "addchannel", description: "Add scrap channel (Usage: /addchannel username) (Admin only)" },
    { command: "broadcast", description: "Send message to all users (Usage: /broadcast text) (Admin only)" },
    { command: "ban", description: "Ban user (Usage: /ban ID) (Admin only)" },
    { command: "unban", description: "Unban user (Usage: /unban ID) (Admin only)" },
]);

// 2. State Management for interactive additions
const adminState: Record<number, 'await_hit' | 'await_miss' | 'await_channel' | 'await_broadcast' | null> = {};

// 3. Middleware: Ban Check & User Sync
bot.use(async (ctx, next) => {
    if (!ctx.from) return await next();

    const userId = BigInt(ctx.from.id);
    const user = await prisma.user.findUnique({ where: { telegramId: userId } });

    if (user?.isBanned) {
        return await ctx.reply(t(user.locale, 'ban_denied'));
    }

    await next();
});

// 4. Main Persistent Navigation
const mainMenu = (locale: string, isAdmin: boolean = false) => {
    const kb = new Keyboard()
        .text(t(locale, 'menu_subs'))
        .text(t(locale, 'menu_profile'))
        .row()
        .text(t(locale, 'menu_settings'));

    if (isAdmin) {
        kb.text(t(locale, 'menu_admin'));
    }

    return kb.resized().persistent();
};

const languageKeyboard = () => {
    return new InlineKeyboard()
        .text("🇺🇦 Українська", "set_lang_ua")
        .text("🇷🇺 Русский", "set_lang_ru")
        .text("🇬🇧 English", "set_lang_en");
};

// --- HELPERS ---

const broadcastToAllUsers = async (text: string, fromAdminId: number) => {
    try {
        const users = await prisma.user.findMany({ where: { isBanned: false } });
        let successCount = 0;
        let failCount = 0;

        for (const user of users) {
            try {
                await bot.api.sendMessage(
                    Number(user.telegramId),
                    `${t(user.locale, 'broadcast_header')}\n\n${text}`,
                    { parse_mode: 'Markdown' }
                );
                successCount++;
            } catch (e) {
                failCount++;
            }
        }

        await bot.api.sendMessage(fromAdminId, `✅ Broadcast complete.\nSent: ${successCount}\nFailed: ${failCount}`);
    } catch (error) {
        logger.error('Broadcast error', undefined, { error });
    }
};

const notifyAllUsersOfNewChannel = async (channelName: string) => {
    try {
        const users = await prisma.user.findMany({ where: { isBanned: false } });

        for (const user of users) {
            try {
                const keyboard = new InlineKeyboard().text(t(user.locale, 'new_channel_btn'), "open_subs");
                await bot.api.sendMessage(
                    Number(user.telegramId),
                    `${t(user.locale, 'new_channel_title')}\n\n${t(user.locale, 'new_channel_msg', { name: channelName })}`,
                    { parse_mode: 'Markdown', reply_markup: keyboard }
                );
            } catch (e) {
                // Skip users who blocked the bot
            }
        }
    } catch (error) {
        logger.error('New channel notification error', undefined, { error });
    }
};

export const notifyAdminsBotAlive = async () => {
    try {
        const admins = await prisma.user.findMany({ where: { isAdmin: true } });
        for (const admin of admins) {
            try {
                await bot.api.sendMessage(
                    Number(admin.telegramId),
                    t(admin.locale, 'bot_online'),
                    { parse_mode: 'Markdown' }
                );
            } catch (e) { }
        }
    } catch (error) {
        logger.error('Startup notification failed', undefined, { error });
    }
};

// --- HANDLERS ---

bot.command('start', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    try {
        const userId = BigInt(from.id);
        const user = await prisma.user.upsert({
            where: { telegramId: userId },
            update: {
                username: from.username || null,
                firstName: from.first_name,
                lastName: from.last_name || null,
            },
            create: {
                telegramId: userId,
                username: from.username || null,
                firstName: from.first_name,
                lastName: from.last_name || null,
                isAdmin: false,
                silentMode: false,
                isBanned: false,
                locale: from.language_code === 'uk' ? 'ua' : (from.language_code === 'ru' ? 'ru' : 'en')
            }
        });

        await ctx.reply(t(user.locale, 'welcome', { name: user.firstName || 'User' }), {
            reply_markup: mainMenu(user.locale, user.isAdmin)
        });
    } catch (error) {
        logger.error('Start error', undefined, { error });
    }
});

bot.command('language', async (ctx) => {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    const locale = user?.locale || 'ua';
    await ctx.reply(t(locale, 'lang_select'), { reply_markup: languageKeyboard() });
});

// --- SETTINGS ---
const showSettings = async (ctx: any) => {
    try {
        const userId = BigInt(ctx.from.id);
        const user = await prisma.user.findUnique({ where: { telegramId: userId } });
        if (!user) return ctx.reply("Please /start first.");

        const status = t(user.locale, user.silentMode ? 'on' : 'off');
        const btnText = t(user.locale, user.silentMode ? 'settings_toggle_silent_off' : 'settings_toggle_silent_on');

        const keyboard = new InlineKeyboard()
            .text(btnText, "toggle_silent")
            .row()
            .text("🌐 Change Language", "change_lang");

        await ctx.reply(`${t(user.locale, 'settings_title')}\n\n${t(user.locale, 'settings_silent_mode', { status })}`, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    } catch (error) {
        logger.error('Settings view error', undefined, { error });
    }
};

bot.command('settings', showSettings);
bot.hears(["⚙️ Settings", "⚙️ Налаштування", "⚙️ Настройки"], showSettings);

// --- PROFILE ---
const showProfile = async (ctx: any) => {
    const userId = BigInt(ctx.from!.id);
    const user = await prisma.user.findUnique({ where: { telegramId: userId }, include: { subscribedTo: true } });
    if (!user) return ctx.reply('Please /start first.');

    const subList = user.subscribedTo.length > 0
        ? user.subscribedTo.map((c: any) => `• ${c.name || c.link}`).join('\n')
        : t(user.locale, 'profile_no_subs');

    const text = `${t(user.locale, 'profile_title')}\n\n` +
        `${t(user.locale, 'profile_id', { id: user.telegramId.toString() })}\n` +
        `${t(user.locale, 'profile_admin', { status: t(user.locale, user.isAdmin ? 'yes' : 'no') })}\n` +
        `${t(user.locale, 'profile_silent', { status: t(user.locale, user.silentMode ? 'on' : 'off') })}\n\n` +
        `${t(user.locale, 'profile_subs')}\n${subList}`;

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: mainMenu(user.locale, user.isAdmin) });
};

bot.command('me', showProfile);
bot.hears(["👤 My Profile", "👤 Мій профіль", "👤 Мой профиль"], showProfile);

// --- SUBSCRIPTIONS ---
const showSubscriptions = async (ctx: any) => {
    try {
        const userId = BigInt(ctx.from!.id);
        const user = await prisma.user.findUnique({ where: { telegramId: userId }, include: { subscribedTo: true } });
        if (!user) return ctx.reply('Please /start first.');

        const allChannels = await prisma.channel.findMany();
        if (allChannels.length === 0) return ctx.reply(t(user.locale, 'subs_no_channels'));

        const keyboard = new InlineKeyboard();
        for (const channel of allChannels) {
            const isSubscribed = user.subscribedTo.some(c => (c as any).id === channel.id);
            const label = `${isSubscribed ? '✅' : '❌'} ${channel.name || channel.link}`;
            keyboard.text(label, `toggle_sub:${channel.id}`).row();
        }

        await ctx.reply(t(user.locale, 'subs_title'), { reply_markup: keyboard });
    } catch (error) {
        logger.error('Sub list error', undefined, { error });
    }
};

bot.command('subscribedTo', showSubscriptions);
bot.hears(["📋 Subscriptions", "📋 Підписки", "📋 Подписки"], showSubscriptions);

// --- ADMIN PANEL ---

const showAdminPanel = async (ctx: any) => {
    const userId = BigInt(ctx.from!.id);
    const user = await prisma.user.findUnique({ where: { telegramId: userId } });

    if (!user?.isAdmin) {
        return ctx.reply("⛔ Access Denied. Admin only.");
    }

    const loc = user.locale;
    const keyboard = new InlineKeyboard()
        .text(t(loc, 'admin_add_hit'), "admin_add_hit")
        .text(t(loc, 'admin_add_miss'), "admin_add_miss")
        .row()
        .text(t(loc, 'admin_add_channel'), "admin_add_channel")
        .text(t(loc, 'admin_broadcast'), "admin_broadcast")
        .row()
        .text(t(loc, 'admin_list_rules'), "admin_list_rules")
        .text(t(loc, 'admin_cleanup'), "admin_compact");

    await ctx.reply(`${t(loc, 'admin_title')}\n\n${t(loc, 'admin_manage_rules')}\n\n${t(loc, 'admin_direct_cmds')}`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
};

bot.command('admin', showAdminPanel);
bot.hears(["🔑 Admin Panel", "🔑 Панель адміна", "🔑 Панель админа"], showAdminPanel);

// --- CALLBACK QUERIES ---

bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userIdNum = ctx.from!.id;
    const userId = BigInt(userIdNum);

    try {
        const user = await prisma.user.findUnique({ where: { telegramId: userId } });
        if (!user) return;

        if (data === "open_subs") {
            await showSubscriptions(ctx);
            await ctx.answerCallbackQuery();
            return;
        }

        if (data === "change_lang") {
            await ctx.editMessageText(t(user.locale, 'lang_select'), { reply_markup: languageKeyboard() });
            await ctx.answerCallbackQuery();
            return;
        }

        if (data.startsWith('set_lang_')) {
            const newLang = data.replace('set_lang_', '');
            const updated = await prisma.user.update({
                where: { telegramId: userId },
                data: { locale: newLang }
            });
            await ctx.answerCallbackQuery(t(newLang, 'lang_changed'));
            await ctx.reply(t(newLang, 'welcome', { name: updated.firstName || 'User' }), {
                reply_markup: mainMenu(newLang, updated.isAdmin)
            });
            // Try to delete original selection message
            try { await ctx.deleteMessage(); } catch (e) { }
            return;
        }

        if (data === "toggle_silent") {
            const updated = await prisma.user.update({
                where: { telegramId: userId },
                data: { silentMode: !user.silentMode }
            });
            await ctx.answerCallbackQuery(t(updated.locale, updated.silentMode ? 'on' : 'off'));

            const status = t(updated.locale, updated.silentMode ? 'on' : 'off');
            const btnText = t(updated.locale, updated.silentMode ? 'settings_toggle_silent_off' : 'settings_toggle_silent_on');
            const keyboard = new InlineKeyboard().text(btnText, "toggle_silent").row().text("🌐 Change Language", "change_lang");

            await ctx.editMessageText(`${t(updated.locale, 'settings_title')}\n\n${t(updated.locale, 'settings_silent_mode', { status })}`, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            return;
        }

        if (data.startsWith('admin_')) {
            if (!user.isAdmin) return ctx.answerCallbackQuery("Denied");

            if (data === "admin_add_hit") {
                adminState[userIdNum] = 'await_hit';
                await ctx.reply("💬 Send the **Keyword** (inclusion):");
            }
            if (data === "admin_add_miss") {
                adminState[userIdNum] = 'await_miss';
                await ctx.reply("💬 Send the **Exclusion** phrase:");
            }
            if (data === "admin_add_channel") {
                adminState[userIdNum] = 'await_channel';
                await ctx.reply("📺 Send the Telegram **Channel link** or **Username**:");
            }
            if (data === "admin_broadcast") {
                adminState[userIdNum] = 'await_broadcast';
                await ctx.reply("📣 Send the **Message** to BROADCAST:");
            }
            if (data === "admin_list_rules") {
                const rules = await prisma.filterPhrase.findMany();
                const text = rules.length === 0
                    ? "No rules active."
                    : rules.map(r => `${r.exclude ? '🚫' : '➕'} ${r.phrase} (ID: ${r.id})`).join('\n');
                await ctx.reply(`*Filter Rules*\n\n${text}`, { parse_mode: 'Markdown' });
            }
            if (data === "admin_compact") {
                const rules = await prisma.filterPhrase.findMany();
                if (rules.length === 0) return ctx.answerCallbackQuery("No rules to compact.");
                await prisma.filterPhrase.deleteMany();
                await (prisma as any).$executeRawUnsafe(`DELETE FROM sqlite_sequence WHERE name='FilterPhrase'`);
                for (const r of rules) {
                    await prisma.filterPhrase.create({ data: { phrase: r.phrase, exclude: r.exclude } });
                }
                await ctx.answerCallbackQuery("Compact complete!");
                await ctx.reply("✨ Rules re-indexed.");
            }
            await ctx.answerCallbackQuery();
            return;
        }

        if (data.startsWith('toggle_sub:')) {
            const channelId = parseInt(data.split(':')[1], 10);
            const userWithSubs = await prisma.user.findUnique({ where: { telegramId: userId }, include: { subscribedTo: true } });
            if (!userWithSubs) return;

            const isSubscribed = userWithSubs.subscribedTo.some(c => (c as any).id === channelId);
            await prisma.user.update({
                where: { telegramId: userId },
                data: { subscribedTo: isSubscribed ? { disconnect: { id: channelId } } : { connect: { id: channelId } } }
            });
            await ctx.answerCallbackQuery(isSubscribed ? 'Unsubscribed' : 'Subscribed');

            const updatedUser = await prisma.user.findUnique({ where: { telegramId: userId }, include: { subscribedTo: true } });
            const allChannels = await prisma.channel.findMany();
            const keyboard = new InlineKeyboard();
            for (const channel of allChannels) {
                const nowSubbed = updatedUser?.subscribedTo.some(c => (c as any).id === channel.id);
                const label = `${nowSubbed ? '✅' : '❌'} ${channel.name || channel.link}`;
                keyboard.text(label, `toggle_sub:${channel.id}`).row();
            }
            await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
        }
    } catch (error) {
        logger.error('Callback error', undefined, { error });
    }
});

// --- ADMIN COMMAND HANDLERS ---

bot.command('hit', async (ctx) => {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    if (!user?.isAdmin) return ctx.reply("⛔ Admin only.");
    const phrase = ctx.match?.trim();
    if (!phrase) return ctx.reply("Usage: `/hit word`", { parse_mode: 'Markdown' });
    try {
        await prisma.filterPhrase.upsert({ where: { phrase }, update: { exclude: false }, create: { phrase, exclude: false } });
        await ctx.reply(`✅ Added keyword: *${phrase}*`, { parse_mode: 'Markdown' });
    } catch (e) { await ctx.reply("Error adding rule."); }
});

bot.command('miss', async (ctx) => {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    if (!user?.isAdmin) return ctx.reply("⛔ Admin only.");
    const phrase = ctx.match?.trim();
    if (!phrase) return ctx.reply("Usage: `/miss word`", { parse_mode: 'Markdown' });
    try {
        await prisma.filterPhrase.upsert({ where: { phrase }, update: { exclude: true }, create: { phrase, exclude: true } });
        await ctx.reply(`🚫 Added exclusion: *${phrase}*`, { parse_mode: 'Markdown' });
    } catch (e) { await ctx.reply("Error adding rule."); }
});

bot.command('rules', async (ctx) => {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    if (!user?.isAdmin) return ctx.reply("⛔ Admin only.");
    const rules = await prisma.filterPhrase.findMany();
    const text = rules.length === 0 ? "No rules." : rules.map(r => `${r.exclude ? '🚫' : '➕'} ${r.phrase} (ID: ${r.id})`).join('\n');
    await ctx.reply(`*Filter Rules*\n\n${text}`, { parse_mode: 'Markdown' });
});

bot.command('del', async (ctx) => {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    if (!user?.isAdmin) return ctx.reply("⛔ Admin only.");
    const ruleId = parseInt(ctx.match?.trim() || "");
    if (isNaN(ruleId)) return ctx.reply("Usage: `/del ID`", { parse_mode: 'Markdown' });
    try {
        await prisma.filterPhrase.delete({ where: { id: ruleId } });
        await ctx.reply(`🗑️ Deleted rule ${ruleId}.`);
    } catch (e) { ctx.reply("Rule not found."); }
});

bot.command('addchannel', async (ctx) => {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    if (!user?.isAdmin) return ctx.reply("⛔ Admin only.");

    let link = ctx.match?.trim();
    if (!link) return ctx.reply("Usage: `/addchannel username`", { parse_mode: 'Markdown' });

    const cleanLink = link.split('/').pop()?.replace('@', '') || '';

    try {
        const existing = await prisma.channel.findUnique({ where: { link: cleanLink } });
        await prisma.channel.upsert({
            where: { link: cleanLink },
            update: { scrapTimeout: 2500 },
            create: { link: cleanLink, name: cleanLink, scrapTimeout: 2500 }
        });
        await ctx.reply(`📺 Channel **@${cleanLink}** added!`, { parse_mode: 'Markdown' });

        if (!existing) {
            await notifyAllUsersOfNewChannel(cleanLink);
        }
    } catch (e) { await ctx.reply("Error adding channel."); }
});

bot.command('broadcast', async (ctx) => {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    if (!user?.isAdmin) return ctx.reply("⛔ Admin only.");

    const text = ctx.match?.trim();
    if (!text) return ctx.reply("Usage: `/broadcast text`", { parse_mode: 'Markdown' });

    await broadcastToAllUsers(text, ctx.from!.id);
});

bot.command('ban', async (ctx) => {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    if (!user?.isAdmin) return ctx.reply("⛔ Admin only.");

    const targetIdStr = ctx.match?.trim();
    if (!targetIdStr) return ctx.reply(t(user.locale, 'ban_usage'), { parse_mode: 'Markdown' });

    try {
        const targetId = BigInt(targetIdStr);
        await prisma.user.update({
            where: { telegramId: targetId },
            data: { isBanned: true }
        });
        await ctx.reply(t(user.locale, 'ban_success', { id: targetIdStr }));
    } catch (e) { await ctx.reply("User not found or error occurred."); }
});

bot.command('unban', async (ctx) => {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    if (!user?.isAdmin) return ctx.reply("⛔ Admin only.");

    const targetIdStr = ctx.match?.trim();
    if (!targetIdStr) return ctx.reply(t(user.locale, 'unban_usage'), { parse_mode: 'Markdown' });

    try {
        const targetId = BigInt(targetIdStr);
        await prisma.user.update({
            where: { telegramId: targetId },
            data: { isBanned: false }
        });
        await ctx.reply(t(user.locale, 'unban_success', { id: targetIdStr }));
    } catch (e) { await ctx.reply("User not found or error occurred."); }
});

// --- MESSAGE HANDLER ---

bot.on('message', async (ctx) => {
    const userIdNum = ctx.from!.id;
    const text = ctx.message.text || "";

    if (adminState[userIdNum]) {
        const state = adminState[userIdNum];

        if (state === 'await_channel') {
            const cleanLink = text.split('/').pop()?.replace('@', '') || '';
            try {
                const existing = await prisma.channel.findUnique({ where: { link: cleanLink } });
                await prisma.channel.upsert({
                    where: { link: cleanLink },
                    update: { scrapTimeout: 2500 },
                    create: { link: cleanLink, name: cleanLink, scrapTimeout: 2500 }
                });
                adminState[userIdNum] = null;
                await ctx.reply(`📺 Channel **@${cleanLink}** added!`, { parse_mode: 'Markdown' });

                if (!existing) {
                    await notifyAllUsersOfNewChannel(cleanLink);
                }
                return;
            } catch (e) {
                adminState[userIdNum] = null;
                await ctx.reply("Error saving channel.");
                return;
            }
        }

        if (state === 'await_broadcast') {
            adminState[userIdNum] = null;
            await broadcastToAllUsers(text, userIdNum);
            return;
        }

        const exclude = state === 'await_miss';
        try {
            await prisma.filterPhrase.upsert({ where: { phrase: text }, update: { exclude }, create: { phrase: text, exclude } });
            adminState[userIdNum] = null;
            await ctx.reply(`✅ Saved: *${text}*`, { parse_mode: 'Markdown' });
            return;
        } catch (e) {
            adminState[userIdNum] = null;
            await ctx.reply("Error saving keyword.");
            return;
        }
    }

    if (text.startsWith('/') || [
        "📋 Subscriptions", "📋 Підписки", "📋 Подписки",
        "👤 My Profile", "👤 Мій профіль", "👤 Мой профиль",
        "⚙️ Settings", "⚙️ Налаштування", "⚙️ Настройки",
        "🔑 Admin Panel", "🔑 Панель адміна", "🔑 Панель админа"
    ].includes(text)) return;

    console.log(`Msg from ${userIdNum}: ${text}`);
});

bot.catch((err) => {
    logger.error('Global Bot Error', undefined, { error: err });
});
