import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Fenêtre
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow:    () => ipcRenderer.send('window:close'),
  openExternal:   (url: string) => ipcRenderer.send('open-external', url),

  // Identité PC (pcAccountId + pairingCode)
  getIdentity: (): Promise<{ pcAccountId: string; pairingCode: string }> =>
    ipcRenderer.invoke('identity:get'),

  // Enregistrement code d'appairage
  registerPair: (pairingCode: string, pcAccountId: string): Promise<void> =>
    ipcRenderer.invoke('pair:register', { pairingCode, pcAccountId }),

  // Licence
  activateLicense: (key: string, deviceName: string): Promise<{ success: boolean; message?: string }> =>
    ipcRenderer.invoke('license:activate', { key, deviceName }),

  checkLicense: (): Promise<{ valid: boolean; offline?: boolean; message?: string }> =>
    ipcRenderer.invoke('license:check'),
});
