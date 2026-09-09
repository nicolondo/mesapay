import { computeNitDv } from "@/lib/erp/exogena";

/** Keep the DV separate: removing punctuation alone appends it to the NIT. */
function colombianNit(raw: string): { number: string; valid: boolean } {
  const compact = raw.trim().replace(/[.\s]/g, "");
  const match = /^(\d{1,15})(?:-(\d))?$/.exec(compact);
  if (!match) return { number: compact, valid: false };
  return {
    number: match[1],
    valid: match[2] === undefined || computeNitDv(match[1]) === match[2],
  };
}

export function compareBeneficiaryIds(input: {
  taxId: string;
  holderDocNumber: string;
  holderDocType: string;
  country: string;
}): { matches: boolean; rutId: string; bankId: string } {
  const generic = (s: string) =>
    s
      .trim()
      .toUpperCase()
      .replace(/[.\s-]/g, "");
  if (input.country !== "CO") {
    const rutId = generic(input.taxId);
    const bankId = generic(input.holderDocNumber);
    return { matches: !!rutId && rutId === bankId, rutId, bankId };
  }
  const rut = colombianNit(input.taxId);
  const bank =
    input.holderDocType === "NIT"
      ? colombianNit(input.holderDocNumber)
      : { number: generic(input.holderDocNumber), valid: true };
  // Do not truncate an unseparated number: a different ID can have a valid
  // checksum by chance. Accept DV only when it is explicitly separated.
  return {
    matches: rut.valid && bank.valid && rut.number === bank.number,
    rutId: rut.number,
    bankId: bank.number,
  };
}
