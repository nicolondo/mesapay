import type { DianInvoiceInput } from '../ubl';

export const originalInvoiceInput: DianInvoiceInput = {
  environment: '2', softwareId: 'software', softwarePin: '12301', technicalKey: 'technical',
  resolution: { number: '18760000001', prefix: 'FE', from: 1, to: 1000, startDate: '2026-01-01', endDate: '2030-01-01' },
  invoiceNumber: 'FE1', issueDate: '2026-10-02', issueTime: '10:00:00-05:00',
  supplier: {
    name: 'Restaurante & Café', companyId: '901944469', dv: '1', idSchemeName: '31',
    personType: '1', taxRegimeCode: '49', taxLevelCode: 'R-99-PN',
    address: { cityCode: '05001', cityName: 'Medellín', deptCode: '05', deptName: 'Antioquia', line: 'Calle 1' },
    email: 'restaurant@example.test',
  },
  customer: {
    name: 'Consumidor final', companyId: '222222222222', idSchemeName: '13',
    personType: '2', taxRegimeCode: '49', taxLevelCode: 'R-99-PN',
  },
  lines: [
    { description: 'Plato & bebida', quantity: 2, unitPriceCents: 10000, lineTotalCents: 20000, taxCents: 1600, taxPct: '8.00', taxSchemeId: '04', itemCode: 'dish-1' },
    { description: 'Excluido', quantity: 1, unitPriceCents: 5000, lineTotalCents: 5000, taxCents: 0, taxPct: '0.00', taxSchemeId: '04', itemCode: 'dish-2' },
  ],
  paymentMeansCode: '10',
};
