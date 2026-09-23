// 서비스 → 후보 화학물질, 참고 물성.
// 물성은 일반 문헌 참고값이며 SERiD DB(DIPPR) / KOSHA 노출기준으로 확인하기 전까지는 확정 정보가 아니다.

export interface ChemRef {
  id: string;
  name: string;
  formula: string;
  cas: string;
  lfl: string; // vol%
  ufl: string;
  flash: string; // °C
  ait: string; // °C
  bp: string; // °C
  twa: string;
  hazards: string[];
}

export const CHEMICALS: Record<string, ChemRef> = {
  methane: { id: "methane", name: "Methane", formula: "CH4", cas: "74-82-8", lfl: "5.0", ufl: "15.0", flash: "−188 (gas)", ait: "537", bp: "−161.5", twa: "N/A — manual", hazards: ["Flammable gas", "Asphyxiant"] },
  ethane: { id: "ethane", name: "Ethane", formula: "C2H6", cas: "74-84-0", lfl: "3.0", ufl: "12.5", flash: "−135 (gas)", ait: "472", bp: "−88.6", twa: "N/A — manual", hazards: ["Flammable gas", "Asphyxiant"] },
  propane: { id: "propane", name: "Propane", formula: "C3H8", cas: "74-98-6", lfl: "2.1", ufl: "9.5", flash: "−104 (gas)", ait: "450", bp: "−42.1", twa: "N/A — manual", hazards: ["Flammable gas"] },
  butane: { id: "butane", name: "n-Butane", formula: "C4H10", cas: "106-97-8", lfl: "1.8", ufl: "8.4", flash: "−60 (gas)", ait: "405", bp: "−0.5", twa: "N/A — manual", hazards: ["Flammable gas"] },
  methanol: { id: "methanol", name: "Methanol", formula: "CH3OH", cas: "67-56-1", lfl: "6.0", ufl: "36", flash: "11", ait: "464", bp: "64.7", twa: "200 ppm", hazards: ["Flammable liquid", "Toxic"] },
  nitrogen: { id: "nitrogen", name: "Nitrogen", formula: "N2", cas: "7727-37-9", lfl: "—", ufl: "—", flash: "—", ait: "—", bp: "−195.8", twa: "N/A (simple asphyxiant)", hazards: ["Asphyxiant", "Cryogenic"] },
};

/** 서비스명·유체 코드로 후보 화학물질 제안 (AI 후보 — 엔지니어가 지정해야 확정) */
export function candidateChemicals(service: string | null, fluidCodes: string[]): { ids: string[]; basis: string } {
  const s = (service ?? "").toUpperCase();
  if (/METHANOL/.test(s)) return { ids: ["methanol"], basis: `서비스명 "${service}"` };
  if (/NITROGEN/.test(s)) return { ids: ["nitrogen"], basis: `서비스명 "${service}"` };
  if (/ETHANE PRODUCT/.test(s)) return { ids: ["ethane", "methane", "propane"], basis: `서비스명 "${service}"` };
  if (/REFLUX/.test(s)) return { ids: ["methane", "ethane"], basis: `서비스명 "${service}" (탈메탄탑 상부)` };
  if (/FEED|RESIDUE|OVERHEAD|GAS/.test(s)) return { ids: ["methane", "ethane", "propane", "butane"], basis: `서비스명 "${service}" (천연가스 계열)` };
  if (fluidCodes.includes("NG")) return { ids: ["nitrogen"], basis: "유체 코드 NG" };
  if (fluidCodes.includes("CHL")) return { ids: ["methanol"], basis: "유체 코드 CHL (메탄올 주입 계통)" };
  return { ids: [], basis: "후보 없음 — 서비스명/유체 코드 부족" };
}
