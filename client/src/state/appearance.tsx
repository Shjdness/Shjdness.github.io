import { createContext } from 'react';

export type AppearanceSettings = {
  backgroundBlur: number;
  backgroundBrightness: number;
  backgroundSaturation: number;
  glassOpacity: number;
  glassBlur: number;
};

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  backgroundBlur: 2,
  backgroundBrightness: 1,
  backgroundSaturation: 1,
  glassOpacity: 0.5,
  glassBlur: 18,
};

export function mergeAppearance(base: AppearanceSettings, override: AppearanceSettings | null) {
  return override ? { ...base, ...override } : base;
}

type AppearanceContextValue = {
  settings: AppearanceSettings;
  defaults: AppearanceSettings;
  setPreview: (settings: AppearanceSettings | null) => void;
  savePersonal: (settings: AppearanceSettings) => void;
  saveDefaults: (settings: AppearanceSettings) => void;
  clearPersonal: () => void;
};

export const AppearanceContext = createContext<AppearanceContextValue>({
  settings: DEFAULT_APPEARANCE,
  defaults: DEFAULT_APPEARANCE,
  setPreview: () => undefined,
  savePersonal: () => undefined,
  saveDefaults: () => undefined,
  clearPersonal: () => undefined,
});
