export type Photo = {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  url: string;
};
export type PhotoData = Photo & { dataUrl: string };
export type PlantIdentification = {
  identified: boolean;
  name: string;
  scientificName: string;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  alternatives: string[];
  needsAnotherPhoto: boolean;
  intervalDays: number | null;
  wateringAdvice: string;
};
export type PhotoAnalysis = { text: string; plant?: PlantIdentification };
