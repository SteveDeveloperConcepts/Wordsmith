/**
 * Preload script: the only bridge between the sandboxed UI and the main process.
 * It exposes a small, explicit API; the page never sees `ipcRenderer` itself.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AiEvent, type DesktopBridge, type MenuAction, type PickedFile, type QuickCapture } from '@shared/api';

function subscribe<T>(channel: string) {
  return (listener: (payload: T) => void) => {
    const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

const bridge: DesktopBridge = {
  info: () => ipcRenderer.invoke(IPC.info),
  notifyReady: () => ipcRenderer.send(IPC.rendererReady),

  pickFiles: () => ipcRenderer.invoke(IPC.pickFiles),
  saveFile: (request) => ipcRenderer.invoke(IPC.saveFile, request),
  savePdf: (defaultName) => ipcRenderer.invoke(IPC.savePdf, defaultName),
  openInDefaultApp: (name, data) => ipcRenderer.invoke(IPC.openInDefaultApp, name, data),
  print: () => ipcRenderer.invoke(IPC.print),

  writeClipboard: (text) => ipcRenderer.invoke(IPC.writeClipboard, text),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme),

  anywhereStatus: () => ipcRenderer.invoke(IPC.anywhereStatus),
  setAnywhere: (patch) => ipcRenderer.invoke(IPC.setAnywhere, patch),
  requestAppControl: () => ipcRenderer.invoke(IPC.requestAppControl),

  quickReady: () => ipcRenderer.send(IPC.quickReady),
  quickReplace: (result) => ipcRenderer.invoke(IPC.quickReplace, result),
  quickCheckAll: () => ipcRenderer.invoke(IPC.quickCheckAll),
  quickUseClipboard: () => ipcRenderer.invoke(IPC.quickUseClipboard),
  quickClose: () => ipcRenderer.invoke(IPC.quickClose),
  quickOpenInApp: (text) => ipcRenderer.invoke(IPC.quickOpenInApp, text),

  aiHasKey: () => ipcRenderer.invoke(IPC.aiHasKey),
  aiSetKey: (key) => ipcRenderer.invoke(IPC.aiSetKey, key),
  aiClearKey: () => ipcRenderer.invoke(IPC.aiClearKey),
  aiStart: (id, model, request) => ipcRenderer.invoke(IPC.aiStart, id, model, request),
  aiCancel: (id) => ipcRenderer.invoke(IPC.aiCancel, id),

  onAiEvent: subscribe<AiEvent>(IPC.aiEvent),
  onMenu: subscribe<MenuAction>(IPC.menu),
  onOpenText: subscribe<string>(IPC.openText),
  onQuickCapture: subscribe<QuickCapture>(IPC.quickCapture),
  onOpenFiles: subscribe<PickedFile[]>(IPC.openFiles),
};

contextBridge.exposeInMainWorld('wordsmith', bridge);
