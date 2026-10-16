const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

const TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; 
const BOT_USERNAME = process.env.BOT_USERNAME;    

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Не заданы SUPABASE_URL или SUPABASE_KEY в переменных окружения!");
} else {
    console.log("🔌 Инициализация клиента Supabase...");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = TOKEN ? new TelegramBot(TOKEN, { polling: false }) : null;

const categoryNames = {
    auto: "🏎️ Авторынок",
    realty: "🏰 Недвижимость",
    business: "💎 Бизнес",
    skins: "👕 Скины/Аксессуары",
    numbers: "📞 Номера/Сим",
    other: "📦 Прочее"
};

// ================= TELEGRAM WEBHOOK =================

app.post('/api/server', async (req, res) => {
    try {
        const update = req.body;

        if (update.message && update.message.text) {
            const text = update.message.text.trim();
            const chatId = update.message.chat.id;

            if (text.startsWith('/start')) {
                if (bot) await bot.sendMessage(chatId, '👋 Бот доски объявлений **РусьАвито** работает на Supabase!', { parse_mode: 'Markdown' });
            }

            if (text.startsWith('/delete')) {
                const parts = text.split(/\s+/);
                const productId = Number(parts[1]);

                if (!productId) {
                    if (bot) await bot.sendMessage(chatId, '❌ Укажите ID объявления.\nПример: <code>/delete 171234567890</code>', { parse_mode: 'HTML' });
                } else {
                    const { error } = await supabase.from('products').delete().eq('id', productId);
                    if (!error) {
                        if (bot) await bot.sendMessage(chatId, `✅ Объявление ID <code>${productId}</code> удалено из базы Supabase!`, { parse_mode: 'HTML' });
                    } else {
                        if (bot) await bot.sendMessage(chatId, `⚠️ Ошибка при удалении лота: ${error.message}`, { parse_mode: 'HTML' });
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
                await supabase.from('products').delete().eq('id', productId);

                if (bot) {
                    await bot.editMessageText(`❌ Объявление (ID: <code>${productId}</code>) удалено!`, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML'
                    }).catch(() => {});
                    await bot.answerCallbackQuery(query.id, { text: 'Удалено!' }).catch(() => {});
                }
            }
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('❌ Ошибка Webhook:', err);
        res.status(500).send('Error');
    }
});

// ================= REST API ДЛЯ ФРОНТЕНДА =================

// Получить все товары
app.get('/api/products', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .order('id', { ascending: false });

        if (error) throw error;

        // Преобразуем формат полей под фронтенд
        const formatted = (data || []).map(p => ({
            id: Number(p.id),
            title: p.title,
            category: p.category,
            server: p.server,
            price: p.price,
            isUrgent: p.is_urgent,
            desc: p.description,
            image: p.image,
            seller: p.seller_json
        }));

        res.json(formatted);
    } catch (err) {
        console.error('❌ Ошибка загрузки товаров:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Получить профиль
app.get('/api/profile/:tgId', async (req, res) => {
    try {
        const tgId = String(req.params.tgId);
        let { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('tg_id', tgId)
            .single();

        if (!data) {
            const defaultProfile = {
                tg_id: tgId,
                site_nick: req.query.defaultName || 'Игрок',
                game_nick: '',
                game_phone: '',
                has_tg: true,
                tg_link: '',
                has_vk: true,
                vk_link: '',
                has_ds: false,
                discord: ''
            };
            const { data: created, error: createErr } = await supabase
                .from('profiles')
                .insert([defaultProfile])
                .select()
                .single();
            
            if (createErr) throw createErr;
            data = created;
        }

        res.json({
            tgId: data.tg_id,
            siteNick: data.site_nick,
            gameNick: data.game_nick,
            gamePhone: data.game_phone,
            hasTg: data.has_tg,
            tgLink: data.tg_link,
            hasVk: data.has_vk,
            vkLink: data.vk_link,
            hasDs: data.has_ds,
            discord: data.discord
        });
    } catch (err) {
        console.error('❌ Ошибка профиля:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Сохранить профиль
app.post('/api/profile', async (req, res) => {
    try {
        const pData = req.body;
        if (!pData.tgId) return res.status(400).json({ error: 'Missing tgId' });

        const payload = {
            tg_id: String(pData.tgId),
            site_nick: pData.siteNick,
            game_nick: pData.gameNick,
            game_phone: pData.gamePhone,
            has_tg: pData.hasTg,
            tg_link: pData.tgLink,
            has_vk: pData.hasVk,
            vk_link: pData.vkLink,
            has_ds: pData.hasDs,
            discord: pData.discord
        };

        const { error } = await supabase
            .from('profiles')
            .upsert(payload, { onConflict: 'tg_id' });

        if (error) throw error;
        res.json({ success: true, profile: pData });
    } catch (err) {
        console.error('❌ Ошибка сохранения профиля:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Создать объявление
app.post('/api/products', async (req, res) => {
    try {
        const product = req.body;
        if (!product.id) product.id = Date.now();

        const catName = categoryNames[product.category] || "Прочее";

        const dbRecord = {
            id: Number(product.id),
            title: product.title,
            category: product.category,
            server: Number(product.server),
            price: product.price,
            is_urgent: Boolean(product.isUrgent),
            description: product.desc,
            image: product.image,
            seller_json: product.seller
        };

        const { error } = await supabase.from('products').insert([dbRecord]);
        if (error) throw error;

        console.log(`📢 Лот ID ${product.id} успешно сохранен в Supabase`);

        if (bot && ADMIN_CHAT_ID) {
            const seller = product.seller || {};
            await bot.sendMessage(ADMIN_CHAT_ID, 
                `📢 <b>НОВОЕ ОБЪЯВЛЕНИЕ В РУСЬАВИТО</b>\n\n` +
                `🆔 <b>ID:</b> <code>${product.id}</code>\n` +
                `🚗 <b>Название:</b> ${product.title}\n` +
                `💰 <b>Цена:</b> ${product.price}\n` +
                `📍 <b>Сервер:</b> #${product.server}\n` +
                `📌 <b>Категория:</b> ${catName}\n` +
                `👤 <b>Продавец:</b> ${seller.siteNick || 'Игрок'} (Тел: <code>${seller.phone || '-'}</code>)\n\n` +
                `📝 <b>Описание:</b> ${product.desc || 'Нет'}\n\n` +
                `⚠️ <i>Удалить: <code>/delete ${product.id}</code></i>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            BOT_USERNAME ? [{ text: '🔍 Посмотреть в приложении', url: `https://t.me/${BOT_USERNAME}/app?startapp=prod_${product.id}` }] : [],
                            [{ text: '🗑️ Удалить лот', callback_data: `delete_prod_${product.id}` }]
                        ].filter(row => row.length > 0)
                    }
                }
            ).catch(err => console.error('Telegram send error:', err.message));
        }

        res.json({ success: true, productId: product.id });
    } catch (err) {
        console.error('❌ Ошибка публикации товара:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Удалить объявление
app.delete('/api/products/:id', async (req, res) => {
    try {
        const productId = Number(req.params.id);
        const { error } = await supabase.from('products').delete().eq('id', productId);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Ошибка удаления:', err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT} (Supabase режим)`);
});
