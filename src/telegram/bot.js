'use strict';

const { Telegraf } = require('telegraf');
const config = require('../config');
const logger = require('../utils/logger');
const { findOrCreateUser, addPhone, removePhone, User } = require('../models/User');
const {
  normalizePhoneNumber,
  isValidPhoneNumber,
  phoneToJid,
} = require('../utils/phone');
const { parseEmojis, normalizeSlot } = require('../utils/emoji');
const {
  spawnSocket,
  requestPairing,
  sessions,
} = require('../whatsapp/socket');
const { STATES, StateStore } = require('./state');
const { mainMenu, backToMenu, phoneList } = require('./keyboards');
const {
  getConfig,
  setSlot,
  clearSlot,
  MAX_SLOTS,
} = require('../models/EmojiConfig');
const { attachAutoReact } = require('./react');

const state = new StateStore();

const SLOT_LABELS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function buildBot() {
  const bot = new Telegraf(config.botToken);

  bot.catch((err, ctx) => {
    logger.error({ err: err?.message, update: ctx.update?.update_id }, 'telegraf error');
  });

  // Wire up the auto-react handler FIRST so every incoming message is
  // observed. Because this is event-driven (no polling delay), the bot
  // typically reacts within the first 100ms of a user posting.
  attachAutoReact(bot);

  bot.start(async (ctx) => {
    const tgId = ctx.from?.id;
    await findOrCreateUser(ctx.chat?.id || tgId, ctx.from || {});
    state.reset(ctx.chat?.id || tgId);
    await ctx.replyWithMarkdownV2(
      [
        '👋 *أهلاً بك في بوت التفاعل التلقائي على الحالات*',
        '',
        'هذا البوت يفعّل التفاعل التلقائي على الحالات مع',
        '*حتى 10 إيموجيات مختلفة* \\(كل خانة إيموجي واحد أو أكثر\\)\\.',
        '',
        'عند نشر حالتي، يتفاعل البوت فوراً بإيموجي عشوائي',
        'من خاناتك المفعّلة، خلال أقل من ثانية\\.',
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

  bot.action('menu:add', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const chatId = ctx.chat?.id || ctx.from?.id;
    state.set(chatId, STATES.WAIT_NUMBER);
    await ctx.editMessageText(
      [
        '➕ *إضافة رقم واتساب جديد*',
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
        '📭 *لا يوجد أرقام مربوطة بعد*\n\nاضغط على "➕ إضافة رقم جديد" للبدء.',
        mainMenu()
      );
    }
    const lines = u.phones.map((p, i) => {
      const on = p.enabled ? '✅' : '⏸';
      const lastSeen = p.lastSeen ? new Date(p.lastSeen).toLocaleString('en-GB') : '—';
      return '*' + (i + 1) + '* \\| ' + on + ' \\`' + p.number + '\\`\n   آخر اتصال: ' + lastSeen;
    });
    await ctx.editMessageText(
      ['📋 *أرقامك المربوطة:*', '', ...lines].join('\n'),
      mainMenu()
    );
  });

  // --- 10-slot auto-react menu -------------------------------------------
  bot.action('menu:emoji', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const tgId = ctx.chat?.id || ctx.from?.id;
    const cfg = await getConfig(tgId);

    const lines = cfg.slots.map((s, i) => {
      const text = String(s?.text || '').trim() || '—';
      return `${SLOT_LABELS[i]} : \`${escapeMd(text)}\``;
    });

    const filled = lines.filter((l) => !l.endsWith('`—`')).length;
    await ctx.editMessageText(
      [
        '😀 *إيموجيات التفاعل التلقائي*',
        '',
        `الخانات المفعّلة: *${filled}* / ${MAX_SLOTS}`,
        '',
        'كل خانة تستقبل إيموجي واحد أو عدة إيموجي متلاصقة',
        '\\(حتى الأعلام والإيموجي المركبة، بدون فواصل\\)\\.',
        'عند نشر أي حالة، يختار البوت خانة عشوائياً ويرد',
        'بالإيموجي داخلها خلال أقل من ثانية\\.',
        '',
        'الأخيار:',
        ...lines,
      ].join('\n'),
      slotKeyboard(cfg)
    );
  });

  function slotKeyboard(cfg) {
    const rows = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      const text = String(cfg.slots[i]?.text || '').trim();
      const label = text ? `${SLOT_LABELS[i]} ${text}` : `${SLOT_LABELS[i]} \\(فارغة\\)`;
      rows.push([
        { text: label.replace(/\\/g, '').replace(/\(/g, '(').replace(/\)/g, ')'), callback_data: `slot:set:${i}` },
        { text: '🧹', callback_data: `slot:clr:${i}` },
      ]);
    }
    rows.push([{ text: '🔙 رجوع للقائمة', callback_data: 'menu:home' }]);
    return { reply_markup: { inline_keyboard: rows } };
  }

  bot.action(/^slot:set:(\d+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const tgId = ctx.chat?.id || ctx.from?.id;
    const idx = Number(ctx.match[1]);
    if (Number.isNaN(idx) || idx < 0 || idx >= MAX_SLOTS) {
      return ctx.editMessageText('❌ خانة غير صالحة.', mainMenu());
    }
    state.set(tgId, STATES.WAIT_EMOJIS, { slotIdx: idx });
    await ctx.editMessageText(
      [
        `${SLOT_LABELS[idx]} *خانة رقم* \\(\`${idx + 1}\`\\)`,
        '',
        'أرسل الآن إيموجي واحد أو عدة إيموجي متلاصقة،',
        '*بدون* فواصل \\(مسافات، فواصل، backticks\\)\\.',
        '',
        'أمثلة مقبولة كما هي:',
        '› `❤️`',
        '› `❤️🔥`',
        '› `💤🇾🇪`',
        '› `🥹❤️🔥💤`',
      ].join('\n'),
      backToMenu()
    );
  });

  bot.action(/^slot:clr:(\d+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const tgId = ctx.chat?.id || ctx.from?.id;
    const idx = Number(ctx.match[1]);
    await clearSlot(tgId, idx);
    // Re-render the slot panel
    const cfg = await getConfig(tgId);
    const lines = cfg.slots.map((s, i) => {
      const text = String(s?.text || '').trim() || '—';
      return `${SLOT_LABELS[i]} : \`${escapeMd(text)}\``;
    });
    const filled = lines.filter((l) => !l.endsWith('`—`')).length;
    await ctx.editMessageText(
      [
        '😀 *إيموجيات التفاعل التلقائي*',
        '',
        `الخانات المفعّلة: *${filled}* / ${MAX_SLOTS}`,
        '',
        ...lines,
      ].join('\n'),
      slotKeyboard(cfg)
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
    const cfg = await getConfig(tgId);
    const live = (u?.phones || []).filter((p) => sessions.has(p.number)).length;
    const total = (u?.phones || []).length;
    const filled = cfg.slots.filter((s) => String(s?.text || '').trim()).length;
    await ctx.editMessageText(
      [
        '📊 *حالة البوت*',
        '',
        `المستخدم: \`${tgId}\``,
        `الأرقام المربوطة: *${total}*`,
        `المتصلة فعلياً: *${live}*`,
        `خانات الإيموجي المفعّلة: *${filled}* / ${MAX_SLOTS}`,
        `وقت التشغيل: ${process.uptime().toFixed(0)} ثانية`,
      ].join('\n'),
      mainMenu()
    );
  });

  bot.on('text', async (ctx) => {
    const tgId = ctx.chat?.id || ctx.from?.id;
    const cur = state.get(tgId);
    // IMPORTANT: do not parse ctx.message.text with parse_mode MarkdownV2 —
    // the user's emoji is verbatim text. apply no escaping, no wrapping.
    const text = ctx.message?.text || '';

    if (cur.state === STATES.WAIT_NUMBER) {
      if (!isValidPhoneNumber(text)) {
        await ctx.reply(
          [
            '⚠️ الرقم غير صالح.',
            'تأكد من:',
            '• إرسال أرقام فقط (بدون + أو مسافات)',
            '• تضمين مفتاح الدولة',
            'مثال: 9665XXXXXXXX',
          ].join('\n')
        );
        return;
      }
      const number = normalizePhoneNumber(text);
      const jid = phoneToJid(number);

      try {
        await addPhone(tgId, number, jid);

        const onConnected = async (pairedNumber) => {
          try {
            // Plain text reply (no parse_mode) so the code displays cleanly
            // and no Markdown escaping mangling happens.
            await ctx.telegram.sendMessage(
              tgId,
              [
                '✅ تم الاتصال بنجاح برقمك',
                '',
                `الرقم: ${pairedNumber}`,
                '',
                '📡 يتم الآن التفاعل تلقائياً على حالات واتساب.',
                'يمكنك تعديل إيموجي التفاعل من القائمة الرئيسية.',
              ].join('\n')
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
        // Plain text code display — no Markdown wrapping, NO backticks around it.
        await ctx.reply(
          [
            `✅ تم تجهيز الاتصال للرقم ${number}`,
            '',
            '🔐 كود الاقتران:',
            '────────────────────',
            `${code}`,
            '────────────────────',
            '',
            '📱 افتح واتساب على هاتفك:',
            '1. الإعدادات  ➜  الأجهزة المرتبطة',
            '2. ربط جهاز',
            '3. ربط عبر رقم بدلاً من ذلك (إذا طُلب)',
            '4. أدخل الكود أعلاه',
            '',
            '⏳ بعد إتمام الربط ستصلك رسالة تأكيد تلقائية.',
          ].join('\n'),
          mainMenu()
        );
        state.reset(tgId);
      } catch (e) {
        logger.error({ e: e?.message, number, tgId }, 'pairing failed');
        await ctx.reply('❌ تعذّر إكمال الربط.\nالسبب: ' + (e?.message || 'unknown'));
        state.reset(tgId);
      }
      return;
    }

    if (cur.state === STATES.WAIT_EMOJIS) {
      const idx = cur.payload.slotIdx;
      // Drop any leftover backticks / code fences the user typed by accident
      // so a message like ❤️ stays exactly ❤️ in the slot.
      const normalized = normalizeSlot(text);

      if (!normalized) {
        return ctx.reply(
          [
            '⚠️ لم أتعرف على إيموجي صالح.',
            '',
            'أرسل إيموجي واحد أو أكثر بدون فواصل ولا علامات تمييل',
            'مثال: ❤️ أو ❤️🔥 أو 💤🇾🇪',
          ].join('\n'),
          backToMenu()
        );
      }

      await setSlot(tgId, idx, normalized);
      state.reset(tgId);
      // Display the slot's evaluated string with NO wrap. MarkdownV2 would
      // re-escape & break composed emoji sequences — keep it plain.
      await ctx.reply(
        [
          `${SLOT_LABELS[idx]} تم حفظ الإيموجي في الخانة ${idx + 1}:`,
          '',
          `${normalized}`,
        ].join('\n'),
        mainMenu()
      );
      return;
    }
  });

  // parseEmojis helper retained for downstream tooling
  void parseEmojis;

  return bot;
}

const MD_ESC_RE = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
function escapeMd(s) {
  return String(s).replace(MD_ESC_RE, (m) => '\\' + m);
}

module.exports = { buildBot };
