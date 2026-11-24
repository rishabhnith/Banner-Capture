# Banner Capture: Chrome extension

Saves the **original image files** of homepage banners from the websites you choose (Boulanger, Fnac, Darty and so on), on a click or once a day.

---

## 1. Install (about 1 minute, once per computer)

1. Unzip `banner-capture.zip`. Keep the **banner-capture** folder somewhere permanent, for example `Documents/banner-capture`. Chrome loads the extension from this folder, so don't delete or move it later.
2. In Chrome, open **chrome://extensions**.
3. Turn on **Developer mode** (switch at the top right).
4. Click **Load unpacked** and select the **banner-capture** folder (the one that contains `manifest.json`).
5. Click the puzzle-piece icon in the toolbar and **pin** Banner Capture so its icon is always visible.

The settings page opens by itself the first time. It also works in **Microsoft Edge** (`edge://extensions`) and **Brave**.

> **One Chrome setting to check:** if Chrome asks where to save *every* download, open `chrome://settings/downloads` and turn off **"Ask where to save each file before downloading"**. Otherwise you would get one Save dialog per banner.

---

## 2. Choose the banners (once per website)

Boulanger, Fnac and Darty are already in the list. For each one:

1. Open the extension's **Settings** (⚙ in the popup) and click **Pick banner** next to the website. The site opens with the picker on top.
2. Move the mouse over the banner and **click it**. If you click one slide of a carousel, the picker selects the **whole carousel** so every slide is captured.
3. Check the thumbnails, give the banner a name (for example "Hero carousel") and click **Save banner**.

Notes:
- **Bigger / Smaller** (or the ↑ / ↓ keys) adjust the selection.
- **Pause** lets you close a cookie pop-up or menu that covers the banner, then resume.
- To add a new website, type its address in Settings → **Add website**. Alternatively, open the website, click the extension icon and choose **Add site & pick banner**.
- A website can have several banners (for example the main carousel and a promo strip).

---

## 3. Capture

- **On a click:** click the toolbar icon, tick the banners you want, and press **Capture selected**. **Capture all** ignores the ticks.
- **Daily:** Settings → **Daily schedule** → switch it on and choose a time. The ticked banners are captured every day at that time.
  - Chrome must be running. If Chrome is closed at the scheduled time, the run starts as soon as Chrome is opened again that day.

Each website opens briefly in a background tab, the banner images are saved, and the tab closes. Nothing is cropped or screenshotted: you get the exact file the website serves, at the largest size it offers (desktop version).

**Test** (in Settings) shows what would be captured without saving anything.

---

## 4. Where the files go

```
Downloads/
└── Banners/
    ├── Boulanger/
    │   └── 2026-11-24/
    │       ├── Hero-carousel_01_3fa9c2.jpg
    │       ├── Hero-carousel_02_81b0de.webp
    │       └── ...
    ├── Fnac/ ...
    └── _logs/
        └── capture_2026-11-24_09-00-12.csv
```

- The number after the banner name is the slide position. The short code is a fingerprint of the image.
- Images keep their original format (JPG, PNG, WebP, AVIF, GIF).
- The **CSV log** has one row per image with these columns: date, time, website, banner, slide, status, size in pixels, file size, *first seen* date, whether it was the slide showing when the page opened, alt text, slide text, the banner's link, image URL and saved file path.
  - The default separator is the comma. For French-language Excel, choose **Semicolon** in Settings → Saving.
- Settings → Last run → **Download full history (CSV)** exports every run in one file.

**Already-saved images** (Settings → Saving). There are three options:
- **Save it again each day, once per day** (default). You get a complete daily record, and re-running on the same day doesn't create duplicates.
- **Only save banners never saved before.** Use this if you only want new campaigns.
- **Always save.**

---

## 5. Sharing with colleagues

1. Send them the zip and this guide.
2. In your Settings → **Share & back up**, click **Export settings file**, and send that `.json` file too.
3. They install the extension (step 1), then Settings → **Import settings file…** → **Replace my list and settings**. They get the same websites and banners with no picking needed.

---

## 6. When something goes wrong

| What you see | What to do |
|---|---|
| **"Banner not found"** in the last run | The website changed its layout. Click **Re-pick** in Settings → Last run (or **Pick it again** after a Test) and click the banner again. The banner keeps its name and history. |
| A Save dialog for every file | Turn off "Ask where to save each file" (see step 1). |
| Arrows or logos get saved | Raise Settings → Saving → *Ignore images narrower than* (default 300 px). |
| A slow website is missed | Settings → Saving → Advanced → raise *Maximum wait for banners to appear*. |
| Nothing happens at the scheduled time | Chrome was closed. The run happens when Chrome is next opened that day. |
| The extension is greyed out or blocked | On company-managed computers, IT can block unpacked extensions. Ask IT to allow it. |

**Updating to a new version:** replace the files inside the same `banner-capture` folder, then click the ↻ (reload) button on the extension's card in `chrome://extensions`. Your websites, banners and history are kept. Don't use *Remove*: that deletes your settings (export them first if you need to).

---

## Privacy

The extension only opens the websites in your list. It runs entirely in your browser, sends nothing anywhere, and saves files only to your Downloads folder. Chrome shows that it can "read and change data on all websites". It needs that permission to open and read whichever websites you add.
