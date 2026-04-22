export type Country = {
  code: string;
  name: string;
  dial: string;
  flag: string;
};

// Curated list — LATAM up front since that's the core market, then the rest
// of the world in a readable order. Names are in Spanish to match the app.
export const COUNTRIES: Country[] = [
  { code: "CO", name: "Colombia", dial: "57", flag: "🇨🇴" },
  { code: "MX", name: "México", dial: "52", flag: "🇲🇽" },
  { code: "AR", name: "Argentina", dial: "54", flag: "🇦🇷" },
  { code: "CL", name: "Chile", dial: "56", flag: "🇨🇱" },
  { code: "PE", name: "Perú", dial: "51", flag: "🇵🇪" },
  { code: "EC", name: "Ecuador", dial: "593", flag: "🇪🇨" },
  { code: "VE", name: "Venezuela", dial: "58", flag: "🇻🇪" },
  { code: "BO", name: "Bolivia", dial: "591", flag: "🇧🇴" },
  { code: "PY", name: "Paraguay", dial: "595", flag: "🇵🇾" },
  { code: "UY", name: "Uruguay", dial: "598", flag: "🇺🇾" },
  { code: "BR", name: "Brasil", dial: "55", flag: "🇧🇷" },
  { code: "CR", name: "Costa Rica", dial: "506", flag: "🇨🇷" },
  { code: "PA", name: "Panamá", dial: "507", flag: "🇵🇦" },
  { code: "GT", name: "Guatemala", dial: "502", flag: "🇬🇹" },
  { code: "HN", name: "Honduras", dial: "504", flag: "🇭🇳" },
  { code: "SV", name: "El Salvador", dial: "503", flag: "🇸🇻" },
  { code: "NI", name: "Nicaragua", dial: "505", flag: "🇳🇮" },
  { code: "CU", name: "Cuba", dial: "53", flag: "🇨🇺" },
  { code: "DO", name: "República Dominicana", dial: "1", flag: "🇩🇴" },
  { code: "PR", name: "Puerto Rico", dial: "1", flag: "🇵🇷" },
  { code: "ES", name: "España", dial: "34", flag: "🇪🇸" },
  { code: "US", name: "Estados Unidos", dial: "1", flag: "🇺🇸" },
  { code: "CA", name: "Canadá", dial: "1", flag: "🇨🇦" },
  { code: "PT", name: "Portugal", dial: "351", flag: "🇵🇹" },
  { code: "FR", name: "Francia", dial: "33", flag: "🇫🇷" },
  { code: "IT", name: "Italia", dial: "39", flag: "🇮🇹" },
  { code: "DE", name: "Alemania", dial: "49", flag: "🇩🇪" },
  { code: "GB", name: "Reino Unido", dial: "44", flag: "🇬🇧" },
  { code: "IE", name: "Irlanda", dial: "353", flag: "🇮🇪" },
  { code: "NL", name: "Países Bajos", dial: "31", flag: "🇳🇱" },
  { code: "BE", name: "Bélgica", dial: "32", flag: "🇧🇪" },
  { code: "CH", name: "Suiza", dial: "41", flag: "🇨🇭" },
  { code: "AT", name: "Austria", dial: "43", flag: "🇦🇹" },
  { code: "SE", name: "Suecia", dial: "46", flag: "🇸🇪" },
  { code: "NO", name: "Noruega", dial: "47", flag: "🇳🇴" },
  { code: "DK", name: "Dinamarca", dial: "45", flag: "🇩🇰" },
  { code: "FI", name: "Finlandia", dial: "358", flag: "🇫🇮" },
  { code: "PL", name: "Polonia", dial: "48", flag: "🇵🇱" },
  { code: "CZ", name: "República Checa", dial: "420", flag: "🇨🇿" },
  { code: "GR", name: "Grecia", dial: "30", flag: "🇬🇷" },
  { code: "TR", name: "Turquía", dial: "90", flag: "🇹🇷" },
  { code: "RU", name: "Rusia", dial: "7", flag: "🇷🇺" },
  { code: "UA", name: "Ucrania", dial: "380", flag: "🇺🇦" },
  { code: "IL", name: "Israel", dial: "972", flag: "🇮🇱" },
  { code: "AE", name: "Emiratos Árabes Unidos", dial: "971", flag: "🇦🇪" },
  { code: "SA", name: "Arabia Saudita", dial: "966", flag: "🇸🇦" },
  { code: "EG", name: "Egipto", dial: "20", flag: "🇪🇬" },
  { code: "MA", name: "Marruecos", dial: "212", flag: "🇲🇦" },
  { code: "ZA", name: "Sudáfrica", dial: "27", flag: "🇿🇦" },
  { code: "NG", name: "Nigeria", dial: "234", flag: "🇳🇬" },
  { code: "KE", name: "Kenia", dial: "254", flag: "🇰🇪" },
  { code: "IN", name: "India", dial: "91", flag: "🇮🇳" },
  { code: "PK", name: "Pakistán", dial: "92", flag: "🇵🇰" },
  { code: "BD", name: "Bangladés", dial: "880", flag: "🇧🇩" },
  { code: "CN", name: "China", dial: "86", flag: "🇨🇳" },
  { code: "HK", name: "Hong Kong", dial: "852", flag: "🇭🇰" },
  { code: "TW", name: "Taiwán", dial: "886", flag: "🇹🇼" },
  { code: "JP", name: "Japón", dial: "81", flag: "🇯🇵" },
  { code: "KR", name: "Corea del Sur", dial: "82", flag: "🇰🇷" },
  { code: "TH", name: "Tailandia", dial: "66", flag: "🇹🇭" },
  { code: "VN", name: "Vietnam", dial: "84", flag: "🇻🇳" },
  { code: "PH", name: "Filipinas", dial: "63", flag: "🇵🇭" },
  { code: "ID", name: "Indonesia", dial: "62", flag: "🇮🇩" },
  { code: "MY", name: "Malasia", dial: "60", flag: "🇲🇾" },
  { code: "SG", name: "Singapur", dial: "65", flag: "🇸🇬" },
  { code: "AU", name: "Australia", dial: "61", flag: "🇦🇺" },
  { code: "NZ", name: "Nueva Zelanda", dial: "64", flag: "🇳🇿" },
];

export const DEFAULT_COUNTRY_CODE = "CO";

export function findCountryByCode(code: string): Country | undefined {
  return COUNTRIES.find((c) => c.code === code);
}
