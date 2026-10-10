export interface AreaDto {
  id: number;
  name: string;
}

/** GET /locations: cities with their areas, e.g. Chandigarh → Sector 22. */
export interface LocationDto {
  id: number;
  name: string;
  areas: AreaDto[];
}

/** GET /service-categories: titles in all three app languages. */
export interface ServiceCategoryDto {
  id: string;
  title: { en: string; hi: string; pa: string };
  iconKey: string;
  color: string;
  bgColor: string;
  baseVisitFee: number;
  examples: string;
}
