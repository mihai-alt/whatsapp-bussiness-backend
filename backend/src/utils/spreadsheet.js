import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';

/**
 * Parse CSV or XLSX into an array of row objects (header → value).
 * Uses exceljs instead of vulnerable sheetjs/xlsx.
 */
export async function parseSpreadsheetFile(file) {
  const ext = path.extname(file.originalname || file.path).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file.path);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];

    const rows = [];
    let headers = [];
    sheet.eachRow((row, rowNumber) => {
      const values = row.values.slice(1).map((v) => {
        if (v == null) return '';
        if (typeof v === 'object' && v.text) return String(v.text);
        if (typeof v === 'object' && v.result != null) return String(v.result);
        return String(v);
      });
      if (rowNumber === 1) {
        headers = values.map((h) => String(h).trim());
        return;
      }
      const obj = {};
      headers.forEach((h, i) => {
        if (!h) return;
        obj[h] = values[i] ?? '';
      });
      rows.push(obj);
    });
    return rows;
  }

  const content = fs.readFileSync(file.path, 'utf8');
  return parse(content, { columns: true, skip_empty_lines: true, trim: true });
}
