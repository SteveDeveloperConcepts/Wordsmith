/// <reference types="office-js" />
import { createOutlookHost } from './outlook';
import { createSelectionHost } from './selection';
import type { Host } from './types';
import { createWordHost } from './word';

export function createHost(type: Office.HostType): Host | null {
  switch (type) {
    case Office.HostType.Word:
      return createWordHost();
    case Office.HostType.Outlook:
      return createOutlookHost();
    case Office.HostType.PowerPoint:
      return createSelectionHost('powerpoint');
    case Office.HostType.Excel:
      return createSelectionHost('excel');
    default:
      return null;
  }
}
