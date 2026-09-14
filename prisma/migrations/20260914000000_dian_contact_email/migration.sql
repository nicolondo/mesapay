-- Correo del emisor para recepción de documentos electrónicos (FAJ71).
-- El emisor puede ser el Restaurant o el LegalEntity del grupo, igual que
-- el resto de los datos fiscales, así que la columna va en los dos.
ALTER TABLE "Restaurant" ADD COLUMN "dianContactEmail" TEXT;
ALTER TABLE "LegalEntity" ADD COLUMN "dianContactEmail" TEXT;
