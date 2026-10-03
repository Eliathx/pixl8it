const MENU_ID = "pixl8it-pixelate";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: "Pixelate", contexts: ["image"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return;

  const src = await resolveSrc(info, tab);

  // data: URLs can be several MB, too big for a query string
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`src:${id}`]: src });

  // extension pages can't open in incognito windows
  const nextToTab = tab && tab.id >= 0 && !tab.incognito;
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`result.html?id=${id}`),
    index: nextToTab ? tab.index + 1 : undefined,
    openerTabId: nextToTab ? tab.id : undefined,
  });
});

// blob: URLs only resolve in the page that created them
async function resolveSrc(info, tab) {
  if (!info.srcUrl.startsWith("blob:") || !tab || tab.id < 0) return info.srcUrl;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      args: [info.srcUrl],
      func: async (url) => {
        const blob = await (await fetch(url)).blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      },
    });
    return result ?? info.srcUrl;
  } catch (err) {
    console.warn("pixl8it: couldn't read blob URL from page", err);
    return info.srcUrl;
  }
}
