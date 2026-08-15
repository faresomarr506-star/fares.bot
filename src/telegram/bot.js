'use strict';

const { Telegraf } = require('telegraf');
const config = require('../config');
const logger = require('../utils/logger');
const { findOrCreateUser, addPhone, removePhone, setEmojis, User } = require('../models/User');
const {
  normalizePhoneNumber,
  isValidPhoneNumber,
  phoneToJid,
} = require('../utils/phone');
const { parseEmojis } = require('../utils/emoji');
const {
  spawnSocket,
  requestPairing,
  bindPhoneEmojis,
  sessions,
} = require('../whatsapp/socket');
const { STATES, StateStore } = require('./state');
const { mainMenu, backToMenu, phoneList } = require('./keyboards');

const state = new StateStore();

function buildBot() {
  const bot = new Telegraf(config.botToken);

  bot.catch((err, ctx) => {
    logger.error({ err: err?.message, update: ctx.update?.update_id }, 'telegraf error');
  });

  bot.start(async (ctx) => {
    await findOrCreateUser(ctx.chat.id, ctx.from || {});
    state.reset(ctx.chat.id);
    await ctx.replyWithMarkdownV2(
      [
        '👋 *أهلاً بك في بوت ربط واتساب*',
        '',
        'هذا البوت يربط رقمك عبر *كود اقتران* من 8 أرقام،',
        'ثم يفعّل خاصية *التفاعل التلقائي على الحالات* \\(Status\\)\\.',
        '',
        'اختر من القائمة التالية 👇',
      ].join('\n'),
      mainMenu()
    );
  });

  bot.action('menu:home', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    state.reset(ctx.chat?.id || ctx.from?.id);
    await ctx.editMessageText(
      '🏠 *القائمة الرئيسية* — اختر أمراً:',
      mainMenu()
    );
  });

  bot.action('menu:link', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const chatId = ctx.chat?.id || ctx.from?.id;
    state.set(chatId, STATES.WAIT_NUMBER);
    await ctx.editMessageText(
      [
        '📲 *ربط رقم واتساب جديد*',
        '',
        'أرسل رقم هاتفك الآن بالتنسيق التالي:',
        '› مفتاح الدولة ثم الرقم',
        '› *بدون* مسافات',
        '› *بدون* علامة `+`',
        '› أرقام فقط \\(0-9\\)',
        '',
        'مثال: `9665XXXXXXXX`',
      ].join('\n'),
      backToMenu()
    );
  });

  bot.action('menu:list', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const tgId = ctx.chat?.id || ctx.from?.id;
    const u = await findOrCreateUser(tgId, ctx.from || {});
    if (!u.phones.length) {
      return ctx.editMessageText(
        '📭 *لا يوجد أرقام مربوطة بعد*\n\nاضغط على "ربط رقم جديد" للبدء.',
        mainMenu()
      );
    }
    const lines = u.phones.map((p, i) => {
      const on = p.enabled ? '✅' : '⏸';
      const emojiJoined = (p.emojis || []).join(' ');
      const lastSeen = p.lastSeen ? new Date(p.lastSeen).toLocaleString('en-GB') : '—';
      return '*' + (i + 1) + '* \\| ' + on + ' \\`' + p.number + '\\`\n   إيموجي: ' + (emojiJoined || '—') + '\n   آخر اتصال: ' + lastSeen;
    });
    await ctx.editMessageText(
      ['📋 *أرقامك المربوطة:*', '', ...lines].join('\n'),
      mainMenu()
    );
  });

  bot.action('menu:emoji', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const tgId = ctx.chat?.id || ctx.from?.id;
    const u = await findOrCreateUser(tgId, ctx.from || {});
    if (!u.phones.length) {
      return ctx.editMessageText(
        '📭 *لا يوجد أرقام مربوطة*\nأضف رقماً أولاً من "ربط رقم جديد".',
        mainMenu()
      );
    }
    state.set(tgId, STATES.WAIT_EMOJI_INDEX);
    await ctx.editMessageText(
      [
        '😀 *تغيير إيموجي التفاعل*',
        '',
        'اختر الرقم الذي تريد تعديل إيموجي التفاعل له:',
        '',
        '💡 يمكنك إرسال الإيموجي لاحقاً بدون فواصل،',
        'حتى الأعلام مثل `🇾🇪` أو الإيموجي المركبة.',
      ].join('\n'),
      phoneList(u.phones, 'emoji:pick')
    );
  });

  bot.action(/^emoji:pick:(\d+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const tgId = ctx.chat?.id || ctx.from?.id;
    const idx = Number(ctx.match[1]);
    const u = await User.findOne({ telegramId: tgId });
    if (!u || !u.phones[idx]) {
      return ctx.editMessageText('❌ خيار غير صالح.', mainMenu());
    }
    state.set(tgId, STATES.WAIT_EMOJIS, { number: u.phones[idx].number });
    await ctx.editMessageText(
      [
        `😀 الرقم المحدد: \`${u.phones[idx].number}\``,
        '',
        'أرسل الإيموجي\\(ي\\) التي تريد استخدامها للتفاعل على حالات واتساب:',
        '› إيموجي واحد أو عدة إيموجي',
        '› يمكن إرسالها *بدون فواصل* \\(مسافة أو بدون\\) ',
        '› الأعلام \\(مثل 🇾🇪\\) والإيموجي المركبة مدعومة',
        '',
        'مثال: `❤️🔥🥹` أو `❤️ 🔥` أو `🇾🇪`',
      ].join('\n'),
      backToMenu()
    );
  });

  bot.action('menu:delete', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const tgId = ctx.chat?.id || ctx.from?.id;
    const u = await findOrCreateUser(tgId, ctx.from || {});
    if (!u.phones.length) {
      return ctx.editMessageText('📭 لا يوجد أرقام للحذف.', mainMenu());
    }
    state.set(tgId, STATES.WAIT_DELETE_INDEX);
    await ctx.editMessageText(
      '🗑 *حذف رقم*\n\nاختر الرقم الذي تريد حذفه (سيتم فصله من البوت):',
      phoneList(u.phones, 'del:pick')
    );
  });

  bot.action(/^del:pick:(\d+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const tgId = ctx.chat?.id || ctx.from?.id;
    const idx = Number(ctx.match[1]);
    const u = await User.findOne({ telegramId: tgId });
    if (!u || !u.phones[idx]) {
      return ctx.editMessageText('❌ خيار غير صالح.', mainMenu());
    }
    const number = u.phones[idx].number;
    try { const { logoutPhone } = require('../whatsapp/socket'); await logoutPhone(number); }
    catch (_) {}
    await removePhone(tgId, number);
    state.reset(tgId);
    await ctx.editMessageText(
      `✅ تم فصل الرقم \`${number}\` من البوت.`,
      mainMenu()
    );
  });

  bot.action('menu:status', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const tgId = ctx.chat?.id || ctx.from?.id;
    const u = await User.findOne({ telegramId: tgId });
    const live = (u?.phones || []).filter((p) => sessions.has(p.number)).length;
    const total = (u?.phones || []).length;
    await ctx.editMessageText(
      [
        '📊 *حالة البوت*',
        '',
        `المستخدم: \`${tgId}\``,
        `الأرقام المربوطة: *${total}*`,
        `المتصلة فعلياً: *${live}*`,
        `وقت التشغيل: ${process.uptime().toFixed(0)} ثانية`,
      ].join('\n'),
      mainMenu()
    );
  });

  bot.on('text', async (ctx) => {
    const tgId = ctx.chat?.id || ctx.from?.id;
    const cur = state.get(tgId);
    const text = (ctx.message?.text || '').trim();

    if (cur.state === STATES.WAIT_NUMBER) {
      if (!isValidPhoneNumber(text)) {
        return ctx.replyWithMarkdownV2(
          [
            '⚠️ *الرقم غير صالح*',
            '',
            'تأكد من:',
            '› إرسال أرقام فقط \\(بدون + أو مسافات\\)',
            '› تضمين مفتاح الدولة',
            '› مثال: `9665XXXXXXXX`',
          ].join('\n'),
          backToMenu()
        );
      }

      const number = normalizePhoneNumber(text);
      const jid = phoneToJid(number);

      try {
        await addPhone(tgId, number, jid);

        // One-shot success notification fired by socket.js the moment the
        // socket reports `connection.update === 'open'` AND credentials are
        // registered (i.e. the user finished entering the pairing code).
        const onConnected = async (pairedNumber) => {
          try {
            await bot.telegram.sendMessage(
              tgId,
              [
                `✅ *تم الاتصال بنجاح برقمك*`,
                '',
                `الرقم: \`${escapeMd(pairedNumber)}\``,
                '',
                '📡 يتم الآن التفاعل تلقائياً على حالات واتساب،',
                'يمكنك تعديل الإيموجي من القائمة الرئيسية.',
              ].join('\n'),
              { parse_mode: 'MarkdownV2' }
            );
          } catch (e) {
            logger.warn({ err: e?.message, tgId }, 'success notification failed');
          }
        };

        await spawnSocket({
          number,
          telegramId: tgId,
          justPaired: true,
          onConnected,
        });
        const code = await requestPairing(number);
        await bindPhoneEmojis(number, (await getEmojisFor(tgId, number)) || ['❤️', '🔥']);
        const safeCode = code?.match?.(/^PAIR-[A-Z0-9]+$/) ? code.slice(5) : code;
        await ctx.replyWithMarkdownV2(
          [
            `✅ تم تجهيز الاتصال للرقم \`${escapeMd(number)}\``,
            '',
            '🔐 *كود الاقتران:*',
            '────────────────────',
            `\`\`\`${safeCode}\`\`\``,
            '────────────────────',
            '',
            '📱 افتح واتساب على هاتفك:',
            '1\\. الإعدادات  ➜  *الأجهزة المرتبطة*',
            '2\\. *ربط جهاز*',
            '3\\. *ربط عبر رقم بدلاً من ذلك* \\(إذا طُلب\\)',
            '4\\. أدخل الكود أعلاه',
            '',
            '⏳ بعد إتمام الربط ستصلك رسالة تأكيد تلقائية\\.',
          ].join('\n'),
          mainMenu()
        );
        state.reset(tgId);
      } catch (e) {
        logger.error({ e: e?.message, number, tgId }, 'pairing failed');
        await ctx.replyWithMarkdownV2(
          [
            '❌ *تعذّر إكمال الربط*',
            '',
            'السبب: `' + escapeMd(e?.message || 'unknown') + '`',
            '',
            'تحقق من الرقم وحاول مرة أخرى.',
          ].join('\n'),
          mainMenu()
        );
        state.reset(tgId);
      }
      return;
    }

    if (cur.state === STATES.WAIT_EMOJIS) {
      const number = cur.payload.number;

      // Grapheme-cluster based parser: handles "❤️ 🔥", "❤️🔥",
      // "🇾🇪" (single flag), and ZWJ family sequences — all without
      // requiring the user to insert any separator.
      const emojis = parseEmojis(text);

      if (!emojis.length) {
        return ctx.replyWithMarkdownV2(
          [
            '⚠️ *لم أتعرف على إيموجي صالح*',
            '',
            'أرسل إيموجي واحد أو أكثر، مثال:',
            '› `❤️ 🔥` \\(مع أو بدون مسافات\\)',
            '› `🇾🇪` \\(علم بدون فواصل\\)',
            '› `❤️🔥🥹` \\(إيموجي متلاصقة\\)',
          ].join('\n'),
          backToMenu()
        );
      }

      await setEmojis(tgId, number, emojis);
      await bindPhoneEmojis(number, emojis);
      state.reset(tgId);
      return ctx.replyWithMarkdownV2(
        [
          `✅ تم تحديث إيموجي الرقم \`${escapeMd(number)}\``,
          '',
          'الإيموجي الحالية: ' + emojis.map((e) => `\`${e}\``).join(' '),
          '',
          'كل إيموجي يُختار عشوائياً لكل حالة \\(Status\\)\\.',
        ].join('\n'),
        mainMenu()
      );
    }
  });

  return bot;
}

async function getEmojisFor(tgId, number) {
  const u = await User.findOne({ telegramId: tgId });
  const p = (u?.phones || []).find((x) => x.number === number);
  return p?.emojis || ['❤️', '🔥'];
}

const MD_ESC_RE = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
function escapeMd(s) {
  return String(s).replace(MD_ESC_RE, (m) => '\\' + m);
}

module.exports = { buildBot };
