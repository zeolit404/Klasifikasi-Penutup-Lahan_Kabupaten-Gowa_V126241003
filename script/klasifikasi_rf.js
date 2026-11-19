// ==============================================================================
// TUGAS PRAKTIKUM KLASIFIKASI PENUTUP LAHAN MENGGUNAKAN RANDOM FOREST DI GEE
// Mata Kuliah : Praktek Pemrograman Spasial (Sub-CPMK 7 Pekan 9–10)
// Mahasiswa   : M. Arief Abdillah
// NIM         : V126241003
// Program Studi: D4 Penginderaan Jauh dan Sistem Informasi Geografis, Universitas Hasanuddin
// Wilayah Kajian: Kabupaten Gowa, Provinsi Sulawesi Selatan
// ==============================================================================

// 1. DEFINISI WILAYAH KAJIAN (AOI)
// Menggunakan batas administrasi Kabupaten Gowa dari dataset FAO GAUL level 2
var gowa = ee.FeatureCollection('FAO/GAUL/2015/level2')
  .filter(ee.Filter.eq('ADM2_NAME', 'Gowa'))
  .first()
  .geometry();

Map.centerObject(gowa, 10);
Map.setOptions('SATELLITE');

// 2. PEMANGGILAN DAN PRA-PEMROSESAN CITRA SENTINEL-2 L2A (HARMONIZED)
function maskS2sr(image) {
  var qa = image.select('QA60');
  var cloudBitMask = 1 << 10;
  var cirrusBitMask = 1 << 11;
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0)
    .and(qa.bitwiseAnd(cirrusBitMask).eq(0));
  return image.updateMask(mask)
    .divide(10000)
    .copyProperties(image, ['system:time_start']);
}

var s2Collection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(gowa)
  .filterDate('2024-05-01', '2024-10-31') // Musim kemarau tutupan awan minimum
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
  .map(maskS2sr);

var composite = s2Collection.median().clip(gowa);

// 3. FEATURE ENGINEERING: PENAMBAHAN PREDIKTOR
// A. Indeks Spektral
var ndvi = composite.normalizedDifference(['B8', 'B4']).rename('NDVI');
var ndwi = composite.normalizedDifference(['B3', 'B8']).rename('NDWI');
var ndbi = composite.normalizedDifference(['B11', 'B8']).rename('NDBI');

// B. Fitur Topografi
var dem = ee.Image('NASA/NASADEM_HGT/001').select('elevation').clip(gowa).rename('DEM');
var slope = ee.Terrain.slope(dem).rename('Slope');

// Gabungkan seluruh band spektral, indeks, dan topografi
var featureBands = ['B2', 'B3', 'B4', 'B8', 'B11', 'B12', 'NDVI', 'NDWI', 'NDBI', 'DEM', 'Slope'];
var predictors = composite.select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'])
  .addBands([ndvi, ndwi, ndbi, dem, slope]);

// 4. PEMBUATAN DATA LATIH & UJI (STRATIFIED RANDOM SAMPLING)
// Menggunakan referensi ESA WorldCover 10m yang diremap ke 4 kelas:
// 1: Vegetasi, 2: Badan Air, 3: Lahan Terbuka, 4: Lahan Terbangun
var esa = ee.Image('ESA/WorldCover/v200/2021').clip(gowa);
var targetLC = esa.remap([10, 20, 30, 40, 50, 60, 80], [1, 1, 1, 1, 4, 3, 2]).rename('class');

var samples = targetLC.stratifiedSample({
  numPoints: 150,
  classBand: 'class',
  region: gowa,
  scale: 30,
  seed: 42,
  geometries: true
}).randomColumn('random', 42);

// Split 70% data latih dan 30% data uji
var trainingPts = samples.filter(ee.Filter.lt('random', 0.7));
var validationPts = samples.filter(ee.Filter.gte('random', 0.7));

print('Jumlah Sampel Latih (70%):', trainingPts.size());
print('Jumlah Sampel Uji (30%)  :', validationPts.size());

// Ekstrak nilai prediktor pada titik sampel
var trainingData = predictors.sampleRegions({
  collection: trainingPts,
  properties: ['class'],
  scale: 30,
  tileScale: 4
});

var validationData = predictors.sampleRegions({
  collection: validationPts,
  properties: ['class'],
  scale: 30,
  tileScale: 4
});

// 5. PELATIHAN MODEL RANDOM FOREST
var classifier = ee.Classifier.smileRandomForest({
  numberOfTrees: 100,
  variablesPerSplit: null,
  minLeafPopulation: 1,
  bagFraction: 0.5,
  seed: 42
}).train({
  features: trainingData,
  classProperty: 'class',
  inputProperties: featureBands
});

// 6. EVALUASI AKURASI MODEL
var validated = validationData.classify(classifier);
var errorMatrix = validated.errorMatrix('class', 'classification');

print('=== MATRIKS EVALUASI AKURASI ===');
print('Confusion Matrix (Validation):', errorMatrix);
print('Overall Accuracy (OA):', errorMatrix.accuracy());
print('Kappa Coefficient   :', errorMatrix.kappa());
print('Producers Accuracy  :', errorMatrix.producersAccuracy());
print('Users Accuracy      :', errorMatrix.consumersAccuracy());

// Feature Importance
var importance = ee.Dictionary(classifier.explain().get('importance'));
print('Feature Importance:', importance);

// 7. KLASIFIKASI CITRA & PERHITUNGAN LUAS
var classified = predictors.classify(classifier);

// Visualisasi di Peta GEE
var rgbVis = {bands: ['B4', 'B3', 'B2'], min: 0.03, max: 0.25, gamma: 1.2};
var lcPalette = ['#2ca02c', '#1f77b4', '#d4ac0d', '#e74c3c'];

Map.addLayer(composite, rgbVis, '1. Citra Sentinel-2 True Color (2024)');
Map.addLayer(classified, {min: 1, max: 4, palette: lcPalette}, '2. Peta Penutup Lahan Random Forest (2024)');
Map.addLayer(trainingPts, {color: 'yellow'}, '3. Titik Sampel Latih (Training)', false);
Map.addLayer(validationPts, {color: 'cyan'}, '4. Titik Sampel Uji (Validation)', false);

// 8. TAMPILKAN LEGENDA KARTOGRAFIS DI CODE EDITOR
var legend = ui.Panel({
  style: {
    position: 'bottom-left',
    padding: '8px 15px',
    backgroundColor: 'rgba(255, 255, 255, 0.9)'
  }
});

var legendTitle = ui.Label({
  value: 'Penutup Lahan Gowa (2024)',
  style: {fontWeight: 'bold', fontSize: '13px', margin: '0 0 6px 0'}
});
legend.add(legendTitle);

var makeRow = function(color, name) {
  var colorBox = ui.Label({
    style: {backgroundColor: color, padding: '8px', margin: '0 8px 4px 0'}
  });
  var description = ui.Label({
    value: name,
    style: {margin: '2px 0 4px 0', fontSize: '11px'}
  });
  return ui.Panel({
    widgets: [colorBox, description],
    layout: ui.Panel.Layout.Flow('horizontal')
  });
};

legend.add(makeRow('#2ca02c', '1. Vegetasi'));
legend.add(makeRow('#1f77b4', '2. Badan Air'));
legend.add(makeRow('#d4ac0d', '3. Lahan Terbuka'));
legend.add(makeRow('#e74c3c', '4. Lahan Terbangun'));

Map.add(legend);
print('Klasifikasi selesai! Peta dan legenda berhasil dimuat pada kanvas.');
