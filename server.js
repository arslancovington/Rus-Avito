const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

const TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // Чат или ID админа для уведомлений
const CHANNEL_ID = process.env.CHANNEL_ID;       // ID или @username вашего публичного канала для публикации
const BOT_USERNAME = process.env.BOT_USERNAME;    

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

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

// ================= TELEGRAM WEBHOOK / МОДЕРАЦИЯ =================

app.post('/api/server', async (req, res) => {
    try {
        const update = req.body;

        if (update.message && update.message.text) {
            const text = update.message.text.trim();
            const chatId = update.message.chat.id;

            if (text.startsWith('/start')) {
                if (bot) await bot.sendMessage(chatId, '👋 Бот модерации **РусьАвито** активен!', { parse_mode: 'Markdown' });
            }

            if (text.startsWith('/delete')) {
                const parts = text.split(/\s+/);
                const productId = Number(parts[1]);

                if (!productId) {
                    if (bot) await bot.sendMessage(chatId, '❌ Укажите ID.\nПример: <code>/delete 171234567890</code>', { parse_mode: 'HTML' });
                } else {
                    await supabase.from('products').delete().eq('id', productId);
                    if (bot) await bot.sendMessage(chatId, `✅ Объявление ID <code>${productId}</code> удалено!`, { parse_mode: 'HTML' });
                }
            }
        }

        // Обработка кнопок админ-панели
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data;
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            // 1. ПЕРЕСЛАТЬ / ОПУБЛИКОВАТЬ В КАНАЛ
            if (data.startsWith('publish_chan_')) {
                const productId = Number(data.replace('publish_chan_', ''));
                
                // Достаем объявление из базы
                const { data: prod, error } = await supabase
                    .from('products')
                    .select('*')
                    .eq('id', productId)
                    .single();

                if (prod && CHANNEL_ID) {
                    const catName = categoryNames[prod.category] || "Прочее";
                    const seller = prod.seller_json || {};

                    // Формируем текст для канала
                    const channelPostText = 
                        `📢 <b>НОВОЕ ОБЪЯВЛЕНИЕ В РУСЬАВИТО</b>\n\n` +
                        `🚗 <b>${prod.title}</b>\n` +
                        `💰 <b>Цена:</b> ${prod.price}\n` +
                        `📍 <b>Сервер:</b> #${prod.server}\n` +
                        `📌 <b>Категория:</b> ${catName}\n\n` +
                        `📝 <b>Описание:</b> ${prod.description || 'Нет'}\n\n` +
                        `👤 <b>Продавец:</b> ${seller.siteNick || 'Игрок'} (Тел: <code>${seller.phone || '-'}</code>)`;

                    // Публикуем в канал (с фото, если оно есть, или текстом)
                    if (prod.image && prod.image.startsWith('http')) {
                        await bot.sendPhoto(CHANNEL_ID, prod.image, {
                            caption: channelPostText,
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    BOT_USERNAME ? [{ text: '👀 Посмотреть в приложении', url: `https://t.me/${BOT_USERNAME}/app?startapp=prod_${prod.id}` }] : []
                                ].filter(r => r.length > 0)
                            }
                        });
                    } else {
                        await bot.sendMessage(CHANNEL_ID, channelPostText, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    BOT_USERNAME ? [{ text: '👀 Посмотреть в приложении', url: `https://t.me/${BOT_USERNAME}/app?startapp=prod_${prod.id}` }] : []
                                ].filter(r => r.length > 0)
                            }
                        });
                    }

                    // Обновляем сообщение у админа в чате модерации
                    await bot.editMessageText(`✅ <b>Опубликовано в канал!</b>\n\n` + query.message.text, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML'
                    }).catch(() => {});
                    
                    await bot.answerCallbackQuery(query.id, { text: 'Успешно отправлено в канал!' });
                } else {
                    await bot.answerCallbackQuery(query.id, { text: '❌ Ошибка: Канал не настроен или лот не найден!' });
                }
            }

            // 2. УДАЛИТЬ ОБЪЯВЛЕНИЕ С ПРОЕКТА
            if (data.startsWith('delete_prod_')) {
                const productId = Number(data.replace('delete_prod_', ''));
                await supabase.from('products').delete().eq('id', productId);

                if (bot) {
                    await bot.editMessageText(`❌ <b>Объявление отклонено и удалено из базы!</b>`, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML'
                    }).catch(() => {});
                    await bot.answerCallbackQuery(query.id, { text: 'Лот удален!' });
                }
            }
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('❌ Webhook error:', err);
        res.status(500).send('Error');
    }
});

// ================= REST API ДЛЯ ФРОНТЕНДА =================

app.get('/api/products', async (req, res) => {
    try {
        const { data, error } = await supabase.from('products').select('*').order('id', { ascending: false });
        if (error) throw error;

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
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/profile/:tgId', async (req, res) => {
    try {
        const tgId = String(req.params.tgId);
        let { data } = await supabase.from('profiles').select('*').eq('tg_id', tgId).single();

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
            const { data: created } = await supabase.from('profiles').insert([defaultProfile]).select().single();
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
        res.status(500).json({ error: err.message });
    }
});

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

        await supabase.from('profiles').upsert(payload, { onConflict: 'tg_id' });
        res.json({ success: true, profile: pData });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

        await supabase.from('products').insert([dbRecord]);

        // Отправка карточки модерации в админ-чат с двумя кнопками
        if (bot && ADMIN_CHAT_ID) {
            const seller = product.seller || {};
            await bot.sendMessage(ADMIN_CHAT_ID, 
                `📢 <b>МОДЕРАЦИЯ НОВОГО ОБЪЯВЛЕНИЯ</b>\n\n` +
                `🆔 <b>ID:</b> <code>${product.id}</code>\n` +
                `🚗 <b>Название:</b> ${product.title}\n` +
                `💰 <b>Цена:</b> ${product.price}\n` +
                `📍 <b>Сервер:</b> #${product.server}\n` +
                `📌 <b>Категория:</b> ${catName}\n` +
                `👤 <b>Продавец:</b> ${seller.siteNick || 'Игрок'} (Тел: <code>${seller.phone || '-'}</code>)\n\n` +
                `📝 <b>Описание:</b> ${product.desc || 'Нет'}`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '📢 Переслать в канал', callback_data: `publish_chan_${product.id}` },
                                { text: '🗑️ Удалить', callback_data: `delete_prod_${product.id}` }
                            ]
                        ]
                    }
                }
            ).catch(err => console.error('Admin notify error:', err.message));
        }

        res.json({ success: true, productId: product.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        const productId = Number(req.params.id);
        await supabase.from('products').delete().eq('id', productId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
