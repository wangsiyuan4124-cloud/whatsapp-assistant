// 从 D:/威麟 的配置表生成插件用的车型资料包 R8车型资料.json（含 FOB 价，只输出到本地，不要提交到仓库）
// 用法：cd tests && node make-catalog.js
// 照片和视频手动放进 D:/威麟/WhatsApp资料包 的子文件夹，文件夹名就是适用的车型组：diesel+gasoline、ev、diesel ……
const X = require('xlsx'), fs = require('fs'), path = require('path');
const SRC = 'D:/威麟', OUT = 'D:/威麟/WhatsApp资料包';
const SHEETS = [
  { group: 'gasoline', file: 'RELY  R8 Gasoline-Euro II Configuration and Pricing.xlsx', sheet: 'Sheet1', names: ['2.4L 5MT 2WD', '2.4L 5MT 4WD'] },
  { group: 'diesel', file: 'RELY R8 DIESEL Configurations and Prices.xlsx', sheet: 'RELY R8 DIESEL ', names: ['2.3T 6MT 4WD Comfort', '2.3T 8AT 4WD Comfort', '2.3T 8AT 4WD Limited'] },
  { group: 'ev', file: 'RELY R8 EV Configurations and Prices.xlsx', sheet: 'RELY R8 EV', names: ['EV 2WD (RWD)', 'EV 4WD (dual motor)'] },
];
const KEY = [
  ['dims', /^长×宽×高/, 'Length × width × height (mm)', 'Largo × ancho × alto (mm)'],
  ['cargo', /^货厢尺寸/, 'Cargo bed L × W × H (mm)', 'Caja de carga L × A × H (mm)'],
  ['wb', /^轴\s*距/, 'Wheelbase (mm)', 'Distancia entre ejes (mm)'],
  ['gc', /离地间隙/, 'Ground clearance, loaded (mm)', 'Altura libre al suelo, con carga (mm)'],
  ['curb', /^整备质量/, 'Curb weight (kg)', 'Peso en vacío (kg)'],
  ['payload', /^额定载/, 'Payload (kg)', 'Carga útil (kg)'],
  ['tow', /^最大拖曳质量（带制动）/, 'Max. towing, braked (kg)', 'Remolque máx. con freno (kg)'],
  ['tires', /^轮胎规格/, 'Tires', 'Neumáticos'],
  ['seats', /^座位数/, 'Seats', 'Asientos'],
  ['engine', /^发动机型号/, 'Engine', 'Motor'],
  ['disp', /^排气量/, 'Displacement (cc)', 'Cilindrada (cc)'],
  ['power', /^额定功率/, 'Power (kW/rpm)', 'Potencia (kW/rpm)'],
  ['torque', /^最大扭矩/, 'Torque (N·m/rpm)', 'Par motor (N·m/rpm)'],
  ['gearbox', /^变速箱型式/, 'Transmission', 'Transmisión'],
  ['drive', /^驱动形式/, 'Drive', 'Tracción'],
  ['tank', /^油箱容积/, 'Fuel tank (L)', 'Tanque de combustible (L)'],
  ['emission', /^产品排放等级/, 'Emissions', 'Emisiones'],
  ['battery', /^电池容量（kWh）/, 'Battery (kWh)', 'Batería (kWh)'],
  ['range', /^续航里程/, 'Range (km, CLTC)', 'Autonomía (km, CLTC)'],
  ['fmotor', /^前电机峰值功率/, 'Front motor peak power (kW)', 'Motor delantero, potencia (kW)'],
  ['rmotor', /^后电机峰值功率/, 'Rear motor peak power (kW)', 'Motor trasero, potencia (kW)'],
  ['rtorque', /^后电机最大扭矩/, 'Rear motor torque (N·m)', 'Motor trasero, par (N·m)'],
  ['modes', /^驾驶模式/, 'Drive modes', 'Modos de conducción'],
];
const FEAT = [
  ['led', /^LED前大灯/, 'LED headlights', 'Faros LED'],
  ['alloy', /^铝合金轮毂/, 'Alloy wheels', 'Rines de aleación'],
  ['keyless', /^无钥匙进入/, 'Keyless entry', 'Entrada sin llave'],
  ['start', /^一键启动/, 'Push-button start', 'Arranque por botón'],
  ['remote', /^钥匙远程启动/, 'Remote engine start', 'Arranque remoto'],
  ['screen12', /^中控悬浮大屏（12'3）/, '12.3" touchscreen', 'Pantalla táctil de 12.3"'],
  ['screen15', /^中控悬浮大屏（15'6）/, '15.6" touchscreen', 'Pantalla táctil de 15.6"'],
  ['carplay', /^手机互联/, 'Wireless CarPlay & Android Auto', 'CarPlay y Android Auto inalámbricos'],
  ['wcharge', /^手机无线充电/, 'Wireless phone charging', 'Cargador inalámbrico'],
  ['radar', /^倒车雷达/, 'Rear parking sensors', 'Sensores de reversa'],
  ['rcam', /^倒车影像/, 'Rear camera', 'Cámara de reversa'],
  ['cam360', /^360°/, '360° camera', 'Cámara 360°'],
  ['leather', /^皮革面料座椅/, 'Leather seats', 'Asientos de cuero'],
  ['vent', /^前排座椅通风/, 'Ventilated front seats', 'Asientos delanteros ventilados'],
  ['heat', /^前排座椅电加热/, 'Heated front seats', 'Asientos delanteros calefactables'],
  ['pseat', /^主驾驶六向电动/, '6-way power driver seat', 'Asiento del conductor eléctrico de 6 vías'],
  ['cruise', /^定速巡航/, 'Cruise control', 'Control de crucero'],
  ['acc', /^自适应巡航/, 'Adaptive cruise control (ACC)', 'Control de crucero adaptativo (ACC)'],
  ['aeb', /^自动紧急制动/, 'Automatic emergency braking', 'Frenado autónomo de emergencia'],
  ['lka', /^车道保持/, 'Lane keeping assist', 'Asistente de mantenimiento de carril'],
  ['bags2', /^前排双安全气囊/, 'Dual front airbags', 'Bolsas de aire frontales'],
  ['bagside', /^侧气囊/, 'Side airbags', 'Bolsas de aire laterales'],
  ['curtain', /^侧气帘/, 'Curtain airbags', 'Bolsas de aire de cortina'],
  ['abs', /^ABS\+EBD/, 'ABS + EBD', 'ABS + EBD'],
  ['esc', /^车身稳定控制/, 'Stability control (ESC)', 'Control de estabilidad (ESC)'],
  ['hill', /^上坡辅助/, 'Hill start assist', 'Asistente de arranque en pendiente'],
  ['epb', /^EPB/, 'Electronic parking brake', 'Freno de estacionamiento eléctrico'],
  ['autohold', /^自动驻车/, 'Auto Hold', 'Auto Hold'],
  ['terrain', /^全地形驾驶模式/, 'All-terrain drive modes', 'Modos de manejo todo terreno'],
  ['rdiff', /^后桥差速锁/, 'Rear differential lock', 'Bloqueo de diferencial trasero'],
  ['tpms', /^胎压/, 'Tire pressure monitoring', 'Monitoreo de presión de llantas'],
  ['roof', /^车顶行李架/, 'Roof rack', 'Barras de techo'],
  ['rollbar', /^货箱防滚架/, 'Cargo bed roll bar', 'Barra antivuelco en la caja'],
  ['outlet', /^220V\/6kW放电面板/, '220 V / 6 kW outlet in cargo bed', 'Toma de 220 V / 6 kW en la caja'],
  ['v2l', /^V2L/, 'V2L power output (vehicle-to-load)', 'Salida de energía V2L'],
];
const FIX = { '两驱（后驱RWD） 2WD': 'RWD', '四驱 4WD': '4WD', '经济、标准、运动（Eco、Normal、Sport）': 'Eco / Normal / Sport', 'M9T（东风轻发）': 'M9T 2.3T turbo diesel' };
const clean = (v) => {
  v = String(v).replace(/\s+/g, ' ').trim();
  if (FIX[v]) return FIX[v];
  if (/^[\/\-—]$/.test(v) || v === '/(不需要)') return '';
  return v.replace(/[\u3400-\u9fff\u3001\uff0c]+/g, ' ').replace(/（\s*）|\(\s*\)/g, '').replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, ' ').trim();
};
const featVal = (v) => (/●/.test(v) ? 'S' : /[○◎]/.test(v) ? 'O' : '');
const groups = {};
for (const s of SHEETS) {
  const rows = X.utils.sheet_to_json(X.readFile(path.join(SRC, s.file)).Sheets[s.sheet], { header: 1, defval: '' });
  const dimRow = rows.find((r) => r.some((c) => /^长×宽×高/.test(String(c).trim())));
  const zhCol = dimRow.findIndex((c) => /^长×宽×高/.test(String(c).trim()));
  const enCol = zhCol + 1;
  const vCols = dimRow.map((c, i) => i).filter((i) => i > enCol && String(dimRow[i]).trim());
  const priceRow = rows.find((r) => r.some((c) => /■\s*价格/.test(String(c))));
  const fobs = vCols.map((i) => { const m = String(priceRow[i]).match(/(\d{4,})/); return m ? +m[1] : null; });
  const versions = vCols.map((c, k) => ({ id: s.group + '-' + (k + 1), name: s.names[k], fob: fobs[k], key: {}, feat: {} }));
  for (const r of rows) {
    const zh = String(r[zhCol] || '').replace(/\s+/g, ' ').trim();
    if (!zh || /^■/.test(zh)) continue;
    const kr = KEY.find(([, re]) => re.test(zh)), fr = FEAT.find(([, re]) => re.test(zh));
    versions.forEach((v, k) => {
      const raw = String(r[vCols[k]] || '').trim();
      if (kr && v.key[kr[0]] === undefined) { const c = clean(raw); if (c) v.key[kr[0]] = c; }
      if (fr && v.feat[fr[0]] === undefined) { const f = featVal(raw); if (f) v.feat[fr[0]] = f; }
    });
  }
  versions.forEach((v) => {
    for (const k of Object.keys(v.key)) {
      let x = v.key[k].replace(/\*/g, '×').replace(/＞/g, '>').replace(/＜/g, '<');
      if (['tow', 'payload', 'curb'].includes(k)) x = x.replace(/\s*kg$/i, '');
      if (k === 'tank') x = x.replace(/\s*L$/, '');
      v.key[k] = x;
    }
  });
  groups[s.group] = versions;
}
const cat = {
  format: 'wat-catalog-1', name: 'RELY R8', updated: new Date().toISOString().slice(0, 10),
  notes: { en: 'Specifications may vary by market and production batch. Photos are for reference.', es: 'Las especificaciones pueden variar según el mercado y el lote de producción. Fotos de referencia.' },
  keyRows: KEY.map(([id, , en, es]) => ({ id, en, es })), featRows: FEAT.map(([id, , en, es]) => ({ id, en, es })),
  groups: [
    { id: 'diesel', zh: '柴油版', title: { en: 'RELY R8 Diesel 4x4 Pickup', es: 'RELY R8 Diésel 4x4 Pick-up' },
      highlights: { en: ['2.3T turbo diesel · 120 kW · 420 N·m', '4WD, 6-speed manual or 8-speed automatic', 'Tows up to 3,000 kg (braked)', 'Cargo bed 1,530 × 1,620 × 515 mm', 'Wireless CarPlay & Android Auto', 'Limited: 15.6" screen, 360° camera, ventilated leather seats, ACC'],
        es: ['2.3T turbo diésel · 120 kW · 420 N·m', 'Tracción 4x4, manual de 6 o automática de 8 velocidades', 'Remolca hasta 3,000 kg (con freno)', 'Caja de carga de 1,530 × 1,620 × 515 mm', 'CarPlay y Android Auto inalámbricos', 'Limited: pantalla de 15.6", cámara 360°, asientos de cuero ventilados, ACC'] },
      pending: [], versions: groups.diesel },
    { id: 'gasoline', zh: '汽油版', title: { en: 'RELY R8 Gasoline Pickup', es: 'RELY R8 Gasolina Pick-up' },
      highlights: { en: ['2.4L Mitsubishi gasoline engine · 118 kW · 230 N·m', '5-speed manual, 2WD or 4WD', 'Tows up to 3,000 kg (braked)', 'Cargo bed 1,530 × 1,620 × 515 mm', '12.3" screen, wireless CarPlay & Android Auto', '360° camera, keyless entry, cruise control'],
        es: ['Motor Mitsubishi 2.4L a gasolina · 118 kW · 230 N·m', 'Manual de 5 velocidades, 4x2 o 4x4', 'Remolca hasta 3,000 kg (con freno)', 'Caja de carga de 1,530 × 1,620 × 515 mm', 'Pantalla de 12.3", CarPlay y Android Auto inalámbricos', 'Cámara 360°, entrada sin llave, control de crucero'] },
      pending: [], versions: groups.gasoline },
    { id: 'ev', zh: 'EV 纯电版', title: { en: 'RELY R8 EV Electric Pickup', es: 'RELY R8 EV Pick-up Eléctrica' },
      highlights: { en: ['100% electric · 88 kWh battery', 'RWD 150 kW, or dual-motor 4WD', '220 V / 6 kW outlet in the cargo bed (V2L)', 'Tows 2,500 kg+ (braked)', 'Leather seats with ventilated front seats', 'No fuel, no oil changes'],
        es: ['100% eléctrica · batería de 88 kWh', 'Tracción trasera de 150 kW, o 4x4 con dos motores', 'Toma de 220 V / 6 kW en la caja (V2L)', 'Remolca más de 2,500 kg (con freno)', 'Asientos de cuero, delanteros ventilados', 'Sin gasolina, sin cambios de aceite'] },
      pending: ['续航里程（厂家配置表为 TBD）', '充电：车辆是中国国标 GB 充电接口，伯利兹当地怎么充电、配什么充电器', '货箱 220V 插座是中国国标，当地电器插头能否直接用', 'EV 版到伯利兹的交付时间'],
      versions: groups.ev },
  ],
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'R8车型资料.json'), JSON.stringify(cat, null, 1));
for (const g of cat.groups) for (const v of g.versions) {
  console.log(g.id, '|', v.name, '| FOB', v.fob, '| key', Object.keys(v.key).length, '| std', Object.entries(v.feat).filter(([, x]) => x === 'S').map(([k]) => k).join(','));
}
console.log(JSON.stringify(cat.groups[2].versions[1].key));
console.log(JSON.stringify(cat.groups[0].versions[2].key));
console.log(JSON.stringify(cat.groups[1].versions[0].key));
