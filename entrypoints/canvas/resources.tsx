import { createContext, useContext } from 'react';
import type { Procedure, Site } from './types';

export interface CanvasResources {
  procedures: Procedure[];
  sites: Site[];
}

export const CanvasResourcesContext = createContext<CanvasResources>({ procedures: [], sites: [] });

export function useCanvasResources(): CanvasResources {
  return useContext(CanvasResourcesContext);
}
