const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'sarathi-secret-key-2026';

app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min = 200, max = 600) => sleep(min + Math.random() * (max - min));

function authCheck(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.body.api_key;
    if (apiKey !== API_KEY) {
        return res.status(401).json({ status: 401, message: 'Unauthorized' });
    }
    next();
}

// Health check
app.get('/', (req, res) => {
    res.json({ status: 200, message: 'Sarathi Scraper running on Railway' });
});

app.get('/health', (req, res) => {
    res.json({ status: 200, healthy: true });
});

// Fetch LL Details
app.post('/fetch-ll', authCheck, async (req, res) => {
    const { llNumber, dob, captcha, sid } = req.body;

    if (!llNumber || !dob || !captcha) {
        return res.status(400).json({ status: 400, message: 'llNumber, dob, captcha required' });
    }

    let browser = null;
    const startTime = Date.now();

    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-gpu',
                '--single-process',
                '--no-zygote',
                '--window-size=1366,768',
            ],
            defaultViewport: { width: 1366, height: 768 },
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7,hi;q=0.6',
        });

        console.log(`[${sid}] Loading form...`);
        await page.goto('https://sarathi.parivahan.gov.in/sarathiservice/displayLLServicesPage.do', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });

        await randomDelay(1500, 2000);

        await page.waitForSelector('#llNumber', { timeout: 20000 });

        console.log(`[${sid}] Filling form...`);

        // LL Number
        await page.click('#llNumber', { clickCount: 3 });
        await page.evaluate(() => { document.querySelector('#llNumber').value = ''; });
        await randomDelay(200, 400);
        await page.type('#llNumber', llNumber, { delay: 60 });

        // DOB
        await randomDelay(300, 500);
        await page.click('#dateOfBirth', { clickCount: 3 });
        await page.evaluate(() => { document.querySelector('#dateOfBirth').value = ''; });
        await randomDelay(200, 400);
        await page.type('#dateOfBirth', dob, { delay: 60 });

        // Captcha
        await randomDelay(300, 500);
        await page.click('#commonCaptcha', { clickCount: 3 });
        await page.evaluate(() => { document.querySelector('#commonCaptcha').value = ''; });
        await randomDelay(200, 400);
        await page.type('#commonCaptcha', captcha, { delay: 60 });

        await randomDelay(500, 800);

        console.log(`[${sid}] Submitting...`);

        try {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
                page.click('#btn_proceed'),
            ]);
        } catch (e) {
            console.log(`[${sid}] Nav timeout, continuing...`);
        }

        await randomDelay(2500, 3500);

        console.log(`[${sid}] Extracting data...`);

        const data = await page.evaluate(() => {
            const getText = (id) => {
                const el = document.getElementById(id);
                return el ? el.textContent.trim() : '';
            };
            const getAttr = (id, attr) => {
                const el = document.getElementById(id);
                return el ? el.getAttribute(attr) : '';
            };

            const divDetails = document.getElementById('div_details');
            const isLoaded = divDetails &&
                !divDetails.classList.contains('display_none') &&
                (!divDetails.style.display || divDetails.style.display !== 'none');

            const errEl = document.getElementById('actionError');
            const errorMessage = errEl ? errEl.textContent.trim() : '';

            const addr = ['addr1', 'addr2', 'addr3', 'addr4']
                .map(id => getText(id))
                .filter(x => x !== '');

            return {
                isDetailsLoaded: isLoaded,
                errorMessage: errorMessage,
                name: getText('fullName'),
                fatherName: getText('swdFullName'),
                mobileNumber: getText('mobileNumber'),
                bloodGroup: getText('bloodGroup'),
                presentAddress: addr.join(', '),
                licenceNumber: getText('licenceNumber'),
                oldLicenceNumber: getText('oldlicenceNumber'),
                dateOfIssue: getText('dateOfIssue'),
                validity: getText('validity'),
                classOfVehicles: getText('classOfVehicles'),
                stateLabel: getText('assStateLbl_id'),
                photo: getAttr('photo', 'src'),
                signature: getAttr('signature', 'src'),
                currentUrl: window.location.href,
            };
        });

        // Fetch photo/signature as base64
        for (const field of ['photo', 'signature']) {
            const src = data[field];
            if (src && !src.startsWith('data:')) {
                try {
                    const fullUrl = src.startsWith('http') ? src : 'https://sarathi.parivahan.gov.in/sarathiservice/' + src.replace(/^\//, '');
                    console.log(`[${sid}] Fetching ${field}...`);
                    const resp = await page.goto(fullUrl, { waitUntil: 'networkidle0', timeout: 30000 });
                    if (resp && resp.status() === 200) {
                        const buffer = await resp.buffer();
                        const ct = resp.headers()['content-type'] || 'image/jpeg';
                        data[field] = 'data:' + ct + ';base64,' + buffer.toString('base64');
                        await page.goBack({ waitUntil: 'domcontentloaded' });
                        await randomDelay(300, 500);
                    }
                } catch (e) {
                    console.log(`[${sid}] ${field} fetch failed:`, e.message);
                }
            }
        }

        const duration = Date.now() - startTime;
        console.log(`[${sid}] Done in ${duration}ms | Name: ${data.name}`);

        if (!data.isDetailsLoaded && !data.name) {
            return res.status(422).json({
                status: 422,
                message: data.errorMessage || 'Applicant details not found',
                data: data,
                duration_ms: duration,
            });
        }

        res.json({
            status: 200,
            step: 'll_details_success',
            data: data,
            duration_ms: duration,
        });

    } catch (error) {
        console.error(`[${sid}] Error:`, error.message);
        res.status(500).json({
            status: 500,
            message: error.message,
            duration_ms: Date.now() - startTime,
        });
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
