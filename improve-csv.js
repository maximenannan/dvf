#!/usr/bin/env node --max-old-space-size=8192
/* eslint camelcase: off */
require('dotenv').config()

const {join} = require('path')
const {createReadStream} = require('fs')
const {Transform} = require('stream')
const bluebird = require('bluebird')
const {ensureDir} = require('fs-extra')
const csvParser = require('csv-parser')
const {createGunzip} = require('gunzip-stream')
const {groupBy} = require('lodash')
const pumpify = require('pumpify').obj
const getStream = require('get-stream')
const centroid = require('@turf/centroid').default
const truncate = require('@turf/truncate').default
const {writeCsv} = require('./lib/csv')
const {getCulturesMap, getCulturesSpecialesMap} = require('./lib/cultures')
const {getDateMutation, getIdParcelle, getCodeCommune, getCodePostal} = require('./lib/parse')
const {getParcellesCommune} = require('./lib/parcelles')
const {getCodeDepartement} = require('./lib/util')

function convertRow(row, {culturesMap, culturesSpecialesMap}) {
  const codeCommune = getCodeCommune(row)

  return {
    date_mutation: getDateMutation(row),
    nature_mutation: row['Nature mutation'],
    valeur_fonciere: Number.parseFloat(row['Valeur fonciere'].replace(',', '.')) || '',
    adresse_numero: row['No voie'],
    adresse_suffixe: row['B/T/Q'],
    adresse_nom_voie: [row['Type de voie'], row.Voie].filter(Boolean).join(' '),
    adresse_code_voie: row['Code voie'],
    code_postal: getCodePostal(row) || '',
    code_commune: codeCommune,
    nom_commune: row.Commune,
    code_departement: getCodeDepartement(codeCommune),
    id_parcelle: getIdParcelle(row),
    numero_volume: row['No Volume'],
    lot1_numero: row['1er lot'],
    lot1_surface_carrez: row['Surface Carrez du 1er lot'],
    lot2_numero: row['2e lot'],
    lot2_surface_carrez: row['Surface Carrez du 2e lot'],
    lot3_numero: row['3e lot'],
    lot3_surface_carrez: row['Surface Carrez du 3e lot'],
    lot4_numero: row['4e lot'],
    lot4_surface_carrez: row['Surface Carrez du 4e lot'],
    lot5_numero: row['5e lot'],
    lot5_surface_carrez: row['Surface Carrez du 5e lot'],
    nombre_lots: row['Nombre de lots'],
    code_type_local: row['Code type local'],
    type_local: row['Type local'],
    surface_reelle_bati: row['Surface reelle bati'],
    nombre_pieces_principales: row['Nombre pieces principales'],
    code_nature_culture: row['Nature culture'],
    nature_culture: row['Nature culture'] in culturesMap ? culturesMap[row['Nature culture']] : '',
    code_nature_culture_speciale: row['Nature culture speciale'],
    nature_culture_speciale: row['Nature culture speciale'] in culturesSpecialesMap ? culturesSpecialesMap[row['Nature culture speciale']] : '',
    surface_terrain: row['Surface terrain'],
    longitude: '',
    latitude: ''
  }
}

const millesimes = ['2018', '2017', '2016', '2015', '2014']

async function main() {
  const culturesMap = await getCulturesMap()
  const culturesSpecialesMap = await getCulturesSpecialesMap()

  await bluebird.each(millesimes, async millesime => {
    console.log(`Millésime ${millesime}`)

    console.log('Chargement des données')

    const rows = await getStream.array(pumpify(
      createReadStream(join(__dirname, 'data', `valeursfoncieres-${millesime}.txt.gz`)),
      createGunzip(),
      csvParser({separator: '|'}),
      new Transform({objectMode: true, transform(row, enc, cb) {
        cb(null, convertRow(row, {culturesMap, culturesSpecialesMap}))
      }})
    ))

    /* Géocodage à la parcelle */

    console.log('Géocodage à la parcelle')

    const communesRows = groupBy(rows, 'code_commune')
    await bluebird.map(Object.keys(communesRows), async codeCommune => {
      const communeRows = communesRows[codeCommune]
      const parcelles = await getParcellesCommune(codeCommune)

      communeRows.forEach(row => {
        if (parcelles && row.id_parcelle in parcelles) {
          const parcelle = parcelles[row.id_parcelle]
          const [lon, lat] = truncate(centroid(parcelle), {precision: 6}).geometry.coordinates
          row.longitude = lon
          row.latitude = lat
        }
      })
    }, {concurrency: 8})

    /* Export des données à la commune */

    console.log('Export des données à la commune')

    const communesGroupedRows = groupBy(rows, 'code_commune')

    await bluebird.map(Object.keys(communesGroupedRows), async codeCommune => {
      const communeRows = communesGroupedRows[codeCommune]
      const codeDepartement = getCodeDepartement(codeCommune)
      const departementPath = join(__dirname, 'dist', millesime, 'communes', codeDepartement)
      await ensureDir(departementPath)
      await writeCsv(join(departementPath, `${codeCommune}.csv`), communeRows)
    }, {concurrency: 8})

    /* Export des données au département */

    console.log('Export des données au département')

    const departementsGroupedRows = groupBy(rows, 'code_departement')

    await bluebird.map(Object.keys(departementsGroupedRows), async codeDepartement => {
      const departementRows = departementsGroupedRows[codeDepartement]
      const departementsPath = join(__dirname, 'dist', millesime, 'departements')
      await ensureDir(departementsPath)
      await writeCsv(join(departementsPath, `${codeDepartement}.csv.gz`), departementRows)
    }, {concurrency: 8})

    /* Export des données complet */

    console.log('Export complet des données')

    const millesimePath = join(__dirname, 'dist', millesime)
    await ensureDir(millesimePath)
    await writeCsv(join(millesimePath, 'full.csv.gz'), rows)
  })
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
