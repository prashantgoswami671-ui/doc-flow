// Diagnostic script: trace exactly why unlocked PDF still reports isEncrypted=true
import { PDFDocument } from '@cantoo/pdf-lib';

async function run() {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  pdf.encrypt({ userPassword: 'test-pass', ownerPassword: 'test-pass' });
  const encryptedBytes = await pdf.save();

  const decrypted = await PDFDocument.load(encryptedBytes, { password: 'test-pass' });
  
  console.log('--- Decrypted Document Indirect Objects ---');
  for (const [ref, obj] of decrypted.context.enumerateIndirectObjects()) {
    console.log(`${ref.toString()}:`, obj.constructor.name, obj.toString().substring(0, 80));
  }

  console.log('\ndecrypted.context.trailerInfo:', decrypted.context.trailerInfo);

  console.log('\nSaving decrypted...');
  const savedBytes = await decrypted.save();
  
  const reopened = await PDFDocument.load(savedBytes, { ignoreEncryption: true });
  console.log('\n--- Reopened Document Indirect Objects ---');
  for (const [ref, obj] of reopened.context.enumerateIndirectObjects()) {
    console.log(`${ref.toString()}:`, obj.constructor.name, obj.toString().substring(0, 80));
  }
  console.log('\nreopened.context.trailerInfo:', reopened.context.trailerInfo);
}

run().catch(console.error);
