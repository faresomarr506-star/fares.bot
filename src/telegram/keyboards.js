'use strict';

function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📲 ربط رقم جديد', callback_data: 'menu:link' }],
        [{ text: '📋 أرقامي المربوطة', callback_data: 'menu:list' }],
        [{ text: '😀 تغيير إيموجي التفاعل', callback_data: 'menu:emoji' }],
        [{ text: '🗑 حذف رقم', callback_data: 'menu:delete' }],
        [{ text: '📊 حالة البوت', callback_data: 'menu:status' }],
      ],
    },
  };
}

function backToMenu() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: '🔙 رجوع للقائمة', callback_data: 'menu:home' }]],
    },
  };
}

function phoneList(phones, actionPrefix) {
  const rows = phones.map((p, i) => [
    { text: `${p.number}`, callback_data: `${actionPrefix}:${i}` },
  ]);
  rows.push([{ text: '🔙 رجوع للقائمة', callback_data: 'menu:home' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

module.exports = { mainMenu, backToMenu, phoneList };
