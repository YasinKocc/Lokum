require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase Bağlantısı
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// public klasöründeki dosyaların dışarı açılmasını sağlar
app.use(express.static(path.join(__dirname, 'public')));

// Ana sayfaya gidildiğinde public/index.html'i gönderir
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// E-posta Gönderici Ayarları
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', // Kendi kurumsal mailinize geçtiğinizde (örn. Hostinger mail) burayı ve portu ona göre güncelleyin.
    port: 465,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Dinamik E-posta Çevirileri
const emailTranslations = {
    en: { subjectTemplate: '🎟️ Your Ticket for {event}', title: "YOU'RE ON THE LIST!", hello: "Hello", msg: "Your payment was successful. Here is your official ticket.", qr: "Please present the QR code below at the door:", footer: "See you soon," },
    tr: { subjectTemplate: '🎟️ {event} Biletiniz', title: "LİSTEDESİNİZ!", hello: "Merhaba", msg: "Ödemeniz başarıyla tamamlandı. İşte resmi biletiniz.", qr: "Lütfen kapıda aşağıdaki QR kodu gösteriniz:", footer: "Görüşmek üzere," },
    nl: { subjectTemplate: '🎟️ Je ticket voor {event}', title: "JE STAAT OP DE LIJST!", hello: "Hallo", msg: "Je betaling is geslaagd. Hier is je officiële ticket.", qr: "Toon de onderstaande QR-code aan de deur:", footer: "Tot snel," },
    fr: { subjectTemplate: '🎟️ Votre billet pour {event}', title: "VOUS ÊTES SUR LA LISTE !", hello: "Bonjour", msg: "Votre paiement a été effectué avec succès. Voici votre billet officiel.", qr: "Veuillez présenter le code QR ci-dessous à l'entrée :", footer: "À bientôt," }
};

// DİKKAT: Stripe Webhook rotası, express.json()'dan ÖNCE gelmelidir!
// Çünkü Stripe imzaları ham veri (raw body) üzerinden doğrular.
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const ticketId = paymentIntent.id;
        const customerName = paymentIntent.metadata.name;
        const customerEmail = paymentIntent.metadata.email;
        const lang = paymentIntent.metadata.lang || 'en'; // Varsayılan İngilizce
        const t = emailTranslations[lang] || emailTranslations['en'];

        try {
            // 1. Bileti veritabanına kaydet
            await supabase.from('tickets').insert([{
                ticket_id: ticketId, 
                customer_name: customerName,
                customer_email: customerEmail, 
                status: 'paid'
            }]);

            // 2. Canlı etkinlik başlığını çek
            const { data: banner } = await supabase.from('banner_config').select('title_text').eq('id', 1).single();
            const eventTitle = banner && banner.title_text ? banner.title_text : "Lokum Event";

            // 3. Başlığı e-posta konusuna (subject) yerleştir
            const dynamicSubject = t.subjectTemplate.replace('{event}', eventTitle);

            // 4. QR Kodu Oluştur
            const qrCodeDataUrl = await QRCode.toDataURL(ticketId);

            // 5. E-posta Ayarları ve Şablonu
            const mailOptions = {
                from: `"Lokum" <${process.env.EMAIL_USER}>`,
                to: customerEmail,
                subject: dynamicSubject,
                html: `
                    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; text-align: center; padding: 40px 20px; background-color: #ffffff;">
                        <img src="cid:logo" alt="Lokum Logo" style="width: 140px; margin-bottom: 30px; display: block; margin-left: auto; margin-right: auto;"/>
                        <h1 style="color: #c41821; text-transform: uppercase; font-size: 28px; margin-bottom: 20px; letter-spacing: 1px;">
                            ${t.title}
                        </h1>
                        <p style="font-size: 16px; color: #1a1a1a; line-height: 1.6; margin-bottom: 10px;">
                            ${t.hello} <strong>${customerName}</strong>,
                        </p>
                        <p style="font-size: 16px; color: #1a1a1a; line-height: 1.6; margin-bottom: 30px;">
                            ${t.msg}
                        </p>
                        <p style="font-weight: bold; margin-bottom: 15px; text-transform: uppercase; font-size: 13px; color: #666; letter-spacing: 1px;">
                            ${t.qr}
                        </p>
                        <div style="margin: 0 auto 30px auto;">
                            <img src="cid:qrcode" alt="Ticket QR Code" style="width: 200px; height: 200px; display: block; margin-left: auto; margin-right: auto;"/>
                        </div>
                        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #f0f0f0;">
                            <p style="font-size: 14px; color: #666; margin: 0;">
                                ${t.footer}<br>
                                <strong style="color: #1a1a1a;">The Lokum Team</strong>
                            </p>
                        </div>
                    </div>
                `,
                attachments: [
                    { 
                        filename: 'Logo.png', 
                        path: path.join(__dirname, 'public', 'Logo.png'),
                        cid: 'logo' 
                    },
                    { 
                        filename: 'ticket-qr.png', 
                        path: qrCodeDataUrl, 
                        cid: 'qrcode' 
                    }
                ]
            };

            await transporter.sendMail(mailOptions);
            console.log(`Ticket emailed in ${lang} to ${customerEmail} with subject: ${dynamicSubject}`);
        } catch (err) { 
            console.error("Database/Email Error:", err); 
        }
    }
    res.json({ received: true });
});

// --- CORS AYARI (Hem yerel test hem de canlı yayın için esnetildi) ---
app.use(cors({
    origin: '*' // Geliştirme aşamasında VS Code Live Server (5500) gibi tüm portlara izin verir.
}));

// --- JSON BODY PARSER (Webhook'tan SONRA gelmeli) ---
app.use(express.json());

// Ödeme İşlemi Rotası
app.post('/create-payment-intent', async (req, res) => {
    try {
        const { name, email, lang, amount } = req.body; 
        
        console.log(`Requested payment amount from app: €${amount}`);

        let paymentAmount = 1000; 
        
        const parsedAmount = parseFloat(amount);
        if (!isNaN(parsedAmount) && parsedAmount > 0) {
            paymentAmount = Math.round(parsedAmount * 100);
        }

        if (paymentAmount < 50) {
            paymentAmount = 50; 
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: paymentAmount,
            currency: 'eur',
            payment_method_types: ['card', 'bancontact'],
            metadata: { name, email, lang } 
        });
        
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (e) { 
        console.error("Stripe Error:", e.message); 
        res.status(500).json({ error: e.message }); 
    }
});

// Sunucuyu Başlat
app.listen(PORT, () => console.log(`🚀 Lokum Engine Running on port ${PORT}`));