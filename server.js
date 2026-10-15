const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const path = require('path');

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

const TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; 
const BOT_USERNAME = process.env.BOT_USERNAME;    

const bot = new TelegramBot(TOKEN);

// Получаем URL базы из Railway
const redisUrl = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL;

console.log("🔍 Проверка REDIS_URL в окружении:", redisUrl ? "Найдена (скрыта в целях безопасности)" : "ОТСУТСТВУЕТ!");

// Инициализация Redis с обработкой ошибок
const redis = new Redis(redisUrl || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

redis.on('connect', () => console.log('✅ Успешное подключение к Redis!'));
redis.on('error', (err) => console.error('❌ Ошибка Redis соединения:', err.message));

// Хелперы для работы с JSON
async function getJson(key) {
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    console.error('Redis GET error:', e.message);
    return null;
  }
}

async function setJson(key, value) {
  try {
    await redis.set(key, JSON.stringify(value));
  } catch (e) {
    console.error('Redis SET error:', e.message);
  }
}

const categoryNames = {
  auto: "🏎️ Авторынок",
  realty: "🏰 Недвижимость",
  business: "💎 Бизнес",
  skins: "👕 Скины/Аксессуары",
  numbers: "📞 Номера/Сим",
  other: "📦 Прочее"
};

// ================= ОБРАБОТКА ВЕБХУКА TELEGRAM =================

app.post('/api/server', async (req, res) => {
  try {
    const update = req.body;

    if (update.message && update.message.text) {
      const text = update.message.text.trim();
      const chatId = update.message.chat.id;

      if (text.startsWith('/start')) {
        await bot.sendMessage(chatId, '👋 Бот доски объявлений РусьАвито работает!');
      }

      if (text.startsWith('/delete')) {
        const parts = text.split(/\s+/);
        const productId = Number(parts[1]);

        if (!productId) {
          await bot.sendMessage(chatId, '❌ Укажите ID объявления.\nПример: <code>/delete 171234567890</code>', { parse_mode: 'HTML' });
        } else {
          let products = (await getJson('products')) || [];
          const initialLength = products.length;
          products = products.filter(p => Number(p.id) !== productId);

          if (products.length < initialLength) {
            await setJson('products', products);
            await bot.sendMessage(chatId, `✅ Объявление ID <code>${productId}</code> удалено!`, { parse_mode: 'HTML' });
          } else {
            await bot.sendMessage(chatId, `⚠️ Объявление с ID <code>${productId}</code> не найдено.`, { parse_mode: 'HTML' });
          }
        }
      }
    }

    if (update.callback_query) {
      const query = update.callback_query;
      const data = query.data;
      const chatId = query.message.chat.id;
      const messageId = query.message.message_id;

      if (data.startsWith('delete_prod_')) {
        const productId = Number(data.replace('delete_prod_', ''));
        let products = (await getJson('products')) || [];
        products = products.filter(p => Number(p.id) !== productId);
        await setJson('products', products);

        await bot.editMessageText(`❌ Объявление (ID: <code>${productId}</code>) удалено!`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        });
        await bot.answerCallbackQuery(query.id, { text: 'Удалено!' });
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(500).send('Error');
  }
});

// ================= REST API ДЛЯ ФРОНТЕНДА =================

app.get('/api/products', async (req, res) => {
  try {
    const products = (await getJson('products')) || [];
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.get('/api/profile/:tgId', async (req, res) => {
  try {
    const tgId = req.params.tgId;
    let profile = await getJson(`profile:${tgId}`);
    if (!profile) {
      profile = { 
        tgId, 
        siteNick: req.query.defaultName || 'Игрок', 
        gameNick: '', 
        gamePhone: ''
      };
      await setJson(`profile:${tgId}`, profile);
    }
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.post('/api/profile', async (req, res) => {
  try {
    const pData = req.body;
    let profile = (await getJson(`profile:${pData.tgId}`)) || {};
    Object.assign(profile, pData);

    await setJson(`profile:${pData.tgId}`, profile);
    res.json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const product = req.body;
    if (!product.id) product.id = Date.now();

    const catName = categoryNames[product.category] || "Прочее";

    let products = (await getJson('products')) || [];
    products.unshift(product);
    await setJson('products', products);

    if (ADMIN_CHAT_ID) {
      await bot.sendMessage(ADMIN_CHAT_ID, 
        `📢 <b>НОВОЕ ОБЪЯВЛЕНИЕ</b>\n\n` +
        `🆔 <b>ID:</b> <code>${product.id}</code>\n` +
        `🚗 <b>Название:</b> ${product.title}\n` +
        `💰 <b>Цена:</b> ${product.price}\n` +
        `📍 <b>Сервер:</b> #${product.server}\n` +
        `📌 <b>Категория:</b> ${catName}\n` +
        `👤 <b>Продавец:</b> ${product.seller.siteNick} (Игровой: <code>${product.seller.nick}</code>, Тел: <code>${product.seller.phone}</code>)\n\n` +
        `📝 <b>Описание:</b> ${product.desc || 'Нет'}\n\n` +
        `⚠️ <i>Удалить: <code>/delete ${product.id}</code></i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Посмотреть в приложении', url: `https://t.me/${BOT_USERNAME}/app?startapp=prod_${product.id}` }],
              [{ text: '🗑️ Удалить лот', callback_data: `delete_prod_${product.id}` }]
            ]
          }
        }
      );
    }

    res.json({ success: true, productId: product.id });
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to publish product' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const productId = Number(req.params.id);
    let products = (await getJson('products')) || [];
    products = products.filter(p => Number(p.id) !== productId);
    await setJson('products', products);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
