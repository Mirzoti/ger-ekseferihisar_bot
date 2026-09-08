require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const {
    BOT_TOKEN,
    AUTHORIZED_CHAT_ID,
    WP_ENDPOINT,
    WP_USERNAME,
    WP_APP_PASSWORD
} = process.env;

const bot = new Telegraf(BOT_TOKEN);

// WordPress REST API yardımcı fonksiyonları (WPAPI yerine axios ile — TLS sorunu çözümü)
const WP_AUTH = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');
const WP_BASE = WP_ENDPOINT.replace(/\/wp-json\/?$/, '') + '/wp-json/wp/v2';

const wpAxios = axios.create({
    baseURL: WP_BASE,
    headers: { Authorization: `Basic ${WP_AUTH}` },
    timeout: 120000, // 2 dakika — büyük görseller için
});

// Medya yükle: buffer + dosya adı alır, WP media ID döner
async function wpUploadMedia(buffer, fileName, title, altText, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const form = new FormData();
            form.append('file', buffer, { filename: fileName, contentType: 'image/jpeg' });
            form.append('title', title);
            form.append('alt_text', altText);

            const res = await axios.post(`${WP_BASE}/media`, form, {
                headers: {
                    ...form.getHeaders(),
                    Authorization: `Basic ${WP_AUTH}`,
                },
                timeout: 120000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
            return res.data; // { id, source_url, ... }
        } catch (err) {
            console.error(`[WP Media Yükleme] Deneme ${attempt}/${retries} başarısız:`, err.message);
            if (attempt === retries) throw err;
            await new Promise(r => setTimeout(r, 3000 * attempt)); // Artan bekleme
        }
    }
}

// 100% Ücretsiz ve API Key Gerektirmeyen SEO Etiket Üretici (AI + Yerel Algoritma)
async function generateSEOTags(title, content) {
    // 1. Önce tamamen ücretsiz Pollinations AI ile dene (API key istemez)
    try {
        const prompt = `Aşağıdaki haber metninden 5 adet SEO anahtar kelimesi/etiketi çıkar. Sadece kelimelerin arasına virgül koy. Örnek: İzmir, Seferihisar, Ekonomi, Belediye, Proje. Başka hiçbir açıklama yazma.\n\nBaşlık: ${title}\nMetin: ${content}`;
        const res = await axios.post('https://text.pollinations.ai/', {
            messages: [{ role: 'user', content: prompt }],
            model: 'openai'
        }, { timeout: 10000 });

        const raw = typeof res.data === 'string' ? res.data : (res.data?.choices?.[0]?.message?.content || '');
        const tags = raw.split(',').map(t => t.trim().replace(/[^a-zA-Z0-9çğıöşüÇĞİÖSHÜ ]/g, '')).filter(t => t.length >= 3);
        if (tags.length >= 3) {
            return tags.slice(0, 5).map(t => t.charAt(0).toUpperCase() + t.slice(1));
        }
    } catch (e) {
        console.warn('Pollinations AI atlandı, yerel algoritmaya geçiliyor:', e.message);
    }

    // 2. Yedek: Yerel Akıllı Kelime Analizi (Asla hata vermez, API key istemez)
    const stopWords = new Set(['bir', 'bu', 've', 'ile', 'için', 'de', 'da', 'ki', 'daha', 'çok', 'gibi', 'kadar', 'sonra', 'önce', 'olan', 'olarak', 'tarafından', 'etti', 'dedi', 'yaptı', 'şeklinde', 'üzerine', 'ayrıca', 'ancak', 'veya', 'göre', 'bulunan']);
    const words = `${title} ${title} ${content}`.replace(/[^a-zA-Z0-9çğıöşüÇĞİÖŞÜ ]/g, ' ').split(/\s+/);
    const wordFreq = {};

    for (let word of words) {
        word = word.trim();
        if (word.length < 4) continue;
        const lower = word.toLowerCase();
        if (stopWords.has(lower)) continue;
        const capitalized = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        wordFreq[capitalized] = (wordFreq[capitalized] || 0) + 1;
    }

    const sorted = Object.keys(wordFreq).sort((a, b) => wordFreq[b] - wordFreq[a]);
    const fallbackTags = sorted.slice(0, 5);
    if (!fallbackTags.map(t => t.toLowerCase()).includes('izmir')) fallbackTags.unshift('İzmir');
    if (!fallbackTags.map(t => t.toLowerCase()).includes('seferihisar')) fallbackTags.push('Seferihisar');
    return fallbackTags.slice(0, 5);
}

// Etiket ara veya oluştur
async function wpGetOrCreateTag(name) {
    const search = await wpAxios.get('/tags', { params: { search: name } });
    if (search.data && search.data.length > 0) return search.data[0].id;
    const created = await wpAxios.post('/tags', { name });
    return created.data.id;
}

// Yazı oluştur
async function wpCreatePost({ title, content, featuredMediaId, tagIds }) {
    const res = await wpAxios.post('/posts', {
        title,
        content,
        status: 'publish',
        featured_media: featuredMediaId,
        categories: [1, 2],
        tags: tagIds,
        meta: { '_esn_numarali_surmanset': 'on' },
    }, { timeout: 60000 });
    return res.data; // { id, link, ... }
}

const allowedChatIds = AUTHORIZED_CHAT_ID.split(',').map(id => parseInt(id.trim(), 10));
const userStates = {};

bot.use((ctx, next) => {
    if (ctx.chat && allowedChatIds.includes(ctx.chat.id)) {
        return next();
    }
    console.log(`Yetkisiz erişim denemesi tespit edildi. ID: ${ctx.chat?.id}`);
});

bot.start(async (ctx) => {
    await ctx.reply('👋 Merhaba! Gerçek Seferhisar Haber Botu aktif.\nLütfen önce haberde kullanmak istediğiniz **fotoğrafı** gönderin.');
});

bot.on('photo', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const photoArray = ctx.message.photo;
        const highestResPhoto = photoArray[photoArray.length - 1];
        const fileLink = await ctx.telegram.getFileLink(highestResPhoto.file_id);
        
        if (!userStates[chatId] || userStates[chatId].step === 'WAITING_FOR_TEXT') {
            userStates[chatId] = { photos: [], step: 'COLLECTING_PHOTOS' };
        }
        
        userStates[chatId].photos.push(fileLink.href);

        if (userStates[chatId].photoTimeout) {
            clearTimeout(userStates[chatId].photoTimeout);
        }

        userStates[chatId].photoTimeout = setTimeout(async () => {
            const photos = userStates[chatId].photos;
            const buttons = photos.map((p, index) => {
                return { text: `${index + 1}`, callback_data: `select_main_${index}` };
            });

            await ctx.reply(`📸 Toplam ${photos.length} adet fotoğraf alındı.\nLütfen afiş (ana görsel) olacak fotoğrafı seçin:`, {
                reply_markup: {
                    inline_keyboard: [buttons]
                }
            });
            
            userStates[chatId].step = 'SELECTING_MAIN_PHOTO';
        }, 2500);

    } catch (error) {
        console.error('Fotoğraf kaydedilirken hata:', error);
        await ctx.reply('❌ Fotoğraf alınırken bir hata oluştu. Lütfen tekrar gönderin.');
    }
});

bot.action(/select_main_(\d+)/, async (ctx) => {
    const chatId = ctx.chat.id;
    const userState = userStates[chatId];

    if (!userState || userState.step !== 'SELECTING_MAIN_PHOTO') {
        return ctx.answerCbQuery('Bu işlem şu an geçerli değil.', { show_alert: true });
    }

    const selectedIndex = parseInt(ctx.match[1]);
    userState.selectedIndex = selectedIndex;

    await ctx.answerCbQuery();

    await ctx.replyWithPhoto({ url: userState.photos[selectedIndex] }, {
        caption: `Seçtiğiniz ${selectedIndex + 1}. fotoğraf bu. Onaylıyor musunuz?`,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Evet', callback_data: 'confirm_main_yes' },
                    { text: '❌ Hayır', callback_data: 'confirm_main_no' }
                ]
            ]
        }
    });
});

bot.action('confirm_main_yes', async (ctx) => {
    const chatId = ctx.chat.id;
    const userState = userStates[chatId];

    if (!userState || userState.step !== 'SELECTING_MAIN_PHOTO') {
        return ctx.answerCbQuery('Bu işlem şu an geçerli değil.', { show_alert: true });
    }

    userState.step = 'WAITING_FOR_TEXT';
    await ctx.answerCbQuery('Onaylandı');
    
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

    await ctx.reply('✅ Ana görsel onaylandı!\n\nŞimdi lütfen haber metnini gönderin.\n*(Not: İlk satır "Başlık", alt satırlar "İçerik" olarak algılanacaktır)*');
});

bot.action('confirm_main_no', async (ctx) => {
    const chatId = ctx.chat.id;
    const userState = userStates[chatId];

    if (!userState || userState.step !== 'SELECTING_MAIN_PHOTO') {
        return ctx.answerCbQuery('Bu işlem şu an geçerli değil.', { show_alert: true });
    }

    await ctx.answerCbQuery('İptal edildi');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

    const photos = userState.photos;
    const buttons = photos.map((p, index) => {
        return { text: `${index + 1}`, callback_data: `select_main_${index}` };
    });

    await ctx.reply('Lütfen tekrar afiş (ana görsel) olacak fotoğrafı seçin:', {
        reply_markup: {
            inline_keyboard: [buttons]
        }
    });
});

bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const userState = userStates[chatId];
    
    if (userState && userState.step === 'WAITING_FOR_TEXT') {
        const fullText = ctx.message.text;
        const lines = fullText.split('\n');
        const title = lines[0];
        const content = lines.slice(1).join('\n').trim();
        
        if (!title || !content) {
            return await ctx.reply('⚠️ Lütfen mesajınızı kontrol edin. En az 2 satır olmalı (1. Satır: Başlık, Diğerleri: İçerik).');
        }

        await ctx.reply('⏳ Fotoğraf medya kütüphanesine yükleniyor ve haberiniz yayınlanıyor. Lütfen bekleyin...');

        try {
            const wpMediaUrls = [];
            const wpMediaIds = [];
            let featuredImageId = null;

            for (let i = 0; i < userState.photos.length; i++) {
                const photoUrl = userState.photos[i];
                await ctx.reply(`📥 Fotoğraf ${i + 1}/${userState.photos.length} indiriliyor ve WordPress'e yükleniyor...`);

                // Görseli indir
                const imageResponse = await axios.get(photoUrl, {
                    responseType: 'arraybuffer',
                    timeout: 60000,
                });
                const imageBuffer = Buffer.from(imageResponse.data);

                const isMain = (i === userState.selectedIndex);
                const fileName = isMain ? `haber_afis_${Date.now()}.jpg` : `haber_foto_${i}_${Date.now()}.jpg`;
                const mediaTitle = title + (isMain ? ' - Öne Çıkan Görsel' : ` - Görsel ${i + 1}`);

                // WordPress'e yükle (retry mekanizmalı)
                const mediaUpload = await wpUploadMedia(imageBuffer, fileName, mediaTitle, title);

                if (isMain) {
                    featuredImageId = mediaUpload.id;
                } else {
                    wpMediaUrls.push(mediaUpload.source_url);
                    wpMediaIds.push(mediaUpload.id);
                }
            }

            // Metin içi görselleri dağıt
            let finalHtmlContent = '';
            const paragraphArray = content.split('\n\n').filter(p => p.trim() !== '');
            let currentImageIndex = 0;

            for (let i = 0; i < paragraphArray.length; i++) {
                finalHtmlContent += paragraphArray[i] + '\n\n';

                // Her 2 paragrafta 1 fotoğraf
                if (i % 2 === 1 && currentImageIndex < wpMediaUrls.length) {
                    finalHtmlContent += `<!-- wp:image {"id":${wpMediaIds[currentImageIndex]},"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${wpMediaUrls[currentImageIndex]}" alt="${title}" class="wp-image-${wpMediaIds[currentImageIndex]}"/></figure>\n<!-- /wp:image -->\n\n`;
                    currentImageIndex++;
                }
            }

            // Artan fotoğrafları sona ekle
            while (currentImageIndex < wpMediaUrls.length) {
                finalHtmlContent += `<!-- wp:image {"id":${wpMediaIds[currentImageIndex]},"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${wpMediaUrls[currentImageIndex]}" alt="${title}" class="wp-image-${wpMediaIds[currentImageIndex]}"/></figure>\n<!-- /wp:image -->\n\n`;
                currentImageIndex++;
            }

            // SEO Etiketleri (Tamamen Ücretsiz AI + Yerel Algoritma)
            let generatedTagIds = [];
            try {
                await ctx.reply('🤖 SEO etiketleri ücretsiz yapay zeka ile oluşturuluyor...');
                const aiTags = await generateSEOTags(title, content);
                await ctx.reply(`🧠 Oluşturulan SEO etiketleri: ${aiTags.join(', ')}\nSisteme entegre ediliyor...`);

                for (const tag of aiTags) {
                    try {
                        const tagId = await wpGetOrCreateTag(tag);
                        generatedTagIds.push(tagId);
                    } catch (e) {
                        console.warn(`[TAG] "${tag}" etiketi eklenemedi:`, e.message);
                    }
                }
            } catch (tagErr) {
                console.error('Etiket Hatası:', tagErr.message);
            }

            const newPost = await wpCreatePost({
                title,
                content: finalHtmlContent,
                featuredMediaId: featuredImageId,
                tagIds: generatedTagIds,
            });

            await ctx.reply(`🎉 Haber başarıyla yayınlandı!\n\n🔗 Link: ${newPost.link}`);
            delete userStates[chatId];

        } catch (error) {
            console.error('WP Yükleme Hatası:', error.response?.data || error.message);
            await ctx.reply(`❌ İçerik WordPress'e yüklenirken hata oluştu!\nHata detayı: ${error.response?.data?.message || error.message || 'Bilinmeyen Hata'}`);
        }
    } else {
        await ctx.reply('⚠️ Haber yayınlamak için önce bana bir **fotoğraf** göndermeniz gerekiyor.');
    }
});

bot.catch((err, ctx) => {
    console.error('Oooops, encountered an error for', ctx.updateType, err);
});

bot.launch().then(() => {
    console.log('Haber Botu basariyla calistirildi ve mesaj bekliyor...');
}).catch(err => {
    console.error('Bot launch error:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const app = express();
app.get('/', (req, res) => {
    res.send('Gercek Seferihisar Botu 7/24 Aktif Olarak Calisiyor!');
});
// Render her web servise ayrı PORT atar veya default 3000 kullanır
const PORT = process.env.PORT || 3000; 
app.listen(PORT, () => {
    console.log(`🌐 Render Web Servisi ${PORT} portunda dinleniyor...`);
});





