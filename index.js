require('dotenv').config();
const { Telegraf } = require('telegraf');
const WPAPI = require('wpapi');
const axios = require('axios');
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

const wp = new WPAPI({
    endpoint: WP_ENDPOINT,
    username: WP_USERNAME,
    password: WP_APP_PASSWORD
});

const allowedChatIds = AUTHORIZED_CHAT_ID.split(',').map(id => parseInt(id.trim(), 10));
const userStates = {};

bot.use((ctx, next) => {
    if (ctx.chat && allowedChatIds.includes(ctx.chat.id)) {
        return next();
    }
    console.log(`Yetkisiz erişim denemesi tespit edildi. ID: ${ctx.chat?.id}`);
});

bot.start((ctx) => {
    ctx.reply('👋 Merhaba! Gerçek Seferhisar Haber Botu aktif.\nLütfen önce haberde kullanmak istediğiniz **fotoğrafı** gönderin.');
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

        userStates[chatId].photoTimeout = setTimeout(() => {
            const photos = userStates[chatId].photos;
            const buttons = photos.map((p, index) => {
                return { text: `${index + 1}`, callback_data: `select_main_${index}` };
            });

            ctx.reply(`📸 Toplam ${photos.length} adet fotoğraf alındı.\nLütfen afiş (ana görsel) olacak fotoğrafı seçin:`, {
                reply_markup: {
                    inline_keyboard: [buttons]
                }
            });
            
            userStates[chatId].step = 'SELECTING_MAIN_PHOTO';
        }, 2500);

    } catch (error) {
        console.error('Fotoğraf kaydedilirken hata:', error);
        ctx.reply('❌ Fotoğraf alınırken bir hata oluştu. Lütfen tekrar gönderin.');
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
            return ctx.reply('⚠️ Lütfen mesajınızı kontrol edin. En az 2 satır olmalı (1. Satır: Başlık, Diğerleri: İçerik).');
        }

        ctx.reply('⏳ Fotoğraf medya kütüphanesine yükleniyor ve haberiniz yayınlanıyor. Lütfen bekleyin...');

        try {
            const wpMediaUrls = [];
            const wpMediaIds = [];
            let featuredImageId = null;

            for (let i = 0; i < userState.photos.length; i++) {
                const photoUrl = userState.photos[i];
                const imageResponse = await axios.get(photoUrl, { responseType: 'arraybuffer' });
                const imageBuffer = Buffer.from(imageResponse.data, 'binary');
                
                const isMain = (i === userState.selectedIndex);
                const fileName = isMain ? `haber_afis_${Date.now()}.jpg` : `haber_foto_${i}_${Date.now()}.jpg`;
                
                const mediaUpload = await wp.media()
                    .file(imageBuffer, fileName)
                    .create({
                        title: title + (isMain ? ' - Öne Çıkan Görsel' : ` - Görsel ${i+1}`),
                        alt_text: title
                    });
                
                if (isMain) {
                    featuredImageId = mediaUpload.id;
                } else {
                    wpMediaUrls.push(mediaUpload.source_url);
                    wpMediaIds.push(mediaUpload.id);
                }
            }

            // Metin ici görselleri dagit
            let finalHtmlContent = "";
            let paragraphArray = content.split('\n\n').filter(p => p.trim() !== '');
            let currentImageIndex = 0;

            for (let i = 0; i < paragraphArray.length; i++) {
                finalHtmlContent += paragraphArray[i] + "\n\n";

                // Her 2 paragrafta 1 fotoğraf (0-indexed oldugu icin i % 2 === 1)
                if (i % 2 === 1 && currentImageIndex < wpMediaUrls.length) {
                    finalHtmlContent += `<!-- wp:image {"id":${wpMediaIds[currentImageIndex]},"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${wpMediaUrls[currentImageIndex]}" alt="${title}" class="wp-image-${wpMediaIds[currentImageIndex]}"/></figure>\n<!-- /wp:image -->\n\n`;
                    currentImageIndex++;
                }
            }

            // Artan fotograflari en sona ekle
            while (currentImageIndex < wpMediaUrls.length) {
                finalHtmlContent += `<!-- wp:image {"id":${wpMediaIds[currentImageIndex]},"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${wpMediaUrls[currentImageIndex]}" alt="${title}" class="wp-image-${wpMediaIds[currentImageIndex]}"/></figure>\n<!-- /wp:image -->\n\n`;
                currentImageIndex++;
            }

            let generatedTags = [];
            if (process.env.GEMINI_API_KEY) {
                try {
                    ctx.reply("🤖 Metin okunuyor, yapay zeka SEO etiketlerini üretiyor...");
                    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
                    const prompt = `Sen profesyonel bir gazeteci ve SEO uzmanısın. Aşağıdaki haber metninden, Google aramalarında en çok tıklanmayı sağlayacak, konuyu en iyi özetleyen 5 anahtar kelimeyi (etiketi) çıkar.
                    Kurallar:
                    1. Sadece kelimelerin arasına virgül koy. (Örn: Haber, Ekonomi, İzmir, Yatırım, Proje)
                    2. Başka tek bir cümle bile yazma. Madde imi, sayı, giriş cümlesi vs. KESİNLİKLE OLMASIN.
                    3. Her kelimenin ilk harfi mutlaka büyük olsun.
                    
                    Haber Başlığı: ${title}
                    Haber Metni: ${content}`;

                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: prompt
                    });

                    const aiTags = response.text.split(',').map(t => t.trim()).filter(t => t.length > 0);
                    ctx.reply(`🧠 Yapay zekanın bulduğu SEO etiketleri: ${aiTags.join(', ')}\nSisteme entegre ediliyor...`);

                    // Etiketlerin WP ID'lerini bul ya da yeni olustur
                    for (const tag of aiTags) {
                        try {
                            const searchRes = await wp.tags().param('search', tag);
                            if (searchRes && searchRes.length > 0) {
                                generatedTags.push(searchRes[0].id);
                            } else {
                                const created = await wp.tags().create({ name: tag });
                                generatedTags.push(created.id);
                            }
                        } catch (e) {
                            // hatali ve benzer etiketleri ustelemeden gec
                        }
                    }
                } catch (aiErr) {
                    console.error("Yapay Zeka Hatasi:", aiErr);
                    ctx.reply("⚠️ Yapay zeka sunucusuna erisilirken hata alindi. Habere etiketsiz devam ediliyor...");
                }
            }

            const newPost = await wp.posts().create({
                title,
                content: finalHtmlContent,
                status: 'publish',
                featured_media: featuredImageId,
                categories: [1, 2],
                tags: generatedTags,
                meta: {
                    '_esn_numarali_surmanset': 'on'
                }
            });

            ctx.reply(`🎉 Haber başarıyla yayınlandı!\n\n🔗 Link: ${newPost.link}`);
            delete userStates[chatId];
            
        } catch (error) {
            console.error('WP Yükleme Hatası:', error);
            ctx.reply(`❌ İçerik WordPress'e yüklenirken hata oluştu!\nHata detayı: ${error.message || 'Bilinmeyen Hata'}`);
        }
    } else {
        ctx.reply('⚠️ Haber yayınlamak için önce bana bir **fotoğraf** göndermeniz gerekiyor.');
    }
});

bot.launch().then(() => {
    console.log('🤖 Haber Botu başarıyla çalıştırıldı ve mesaj bekliyor...');
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
