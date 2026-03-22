require('dotenv').config();
const { Telegraf } = require('telegraf');
const WPAPI = require('wpapi');
const axios = require('axios');
const express = require('express');

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
        
        userStates[chatId] = {
            step: 'WAITING_FOR_TEXT',
            photoUrl: fileLink.href
        };
        
        ctx.reply('✅ Fotoğrafı aldım! Şimdi lütfen haber atın.\n\n*(Not: Attığınız mesajın ilk satırı "Başlık", alt satırları ise "Haber Uzun Metni" olarak algılanacaktır)*');
    } catch (error) {
        console.error('Fotoğraf kaydedilirken hata:', error);
        ctx.reply('❌ Fotoğraf alınırken bir hata oluştu. Lütfen tekrar gönderin.');
    }
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
            const imageResponse = await axios.get(userState.photoUrl, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(imageResponse.data, 'binary');
            
            const fileName = `haber_foto_${Date.now()}.jpg`;
            const mediaUpload = await wp.media()
                .file(imageBuffer, fileName)
                .create({
                    title: title + ' - Öne Çıkan Görsel',
                    alt_text: title
                });
                
            const featuredImageId = mediaUpload.id;

            const newPost = await wp.posts().create({
                title,
                content: content,
                status: 'publish',
                featured_media: featuredImageId,
                categories: [29],
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
