import assert from 'node:assert/strict';
import XLSX from 'xlsx';

const workbook=XLSX.utils.book_new();
const identifier='12345678901234567890';
XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['编号','说明'],[identifier,'共享字符串不能变成索引']]),'技术参数');
XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['项目','数值'],['额定功率',37.5]]),'校核结果');
const roundTrip=XLSX.read(XLSX.write(workbook,{bookType:'xlsx',type:'buffer'}),{type:'buffer',cellFormula:false,cellHTML:false});
assert.deepEqual(roundTrip.SheetNames,['技术参数','校核结果']);
const html=roundTrip.SheetNames.map(name=>`<h2>${name}</h2>${XLSX.utils.sheet_to_html(roundTrip.Sheets[name])}`).join('');
assert.match(html,new RegExp(identifier),'长文本编号不能被共享字符串索引替代');
assert.match(html,/共享字符串不能变成索引/);
assert.match(html,/37\.5/);
console.log('Document format smoke test passed');
