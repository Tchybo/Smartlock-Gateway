/**
 * Vlož do svého ~/.node-red/settings.js (rozšíření existujícího exportu):
 *
 *   functionGlobalContext: {
 *     slk: require('./slk-protocol.js')
 *   },
 *   functionExternalModules: true,
 *
 * a soubor slk-protocol.js zkopíruj do ~/.node-red/.
 *
 * Tím získáš ve všech function nodech přístup přes:
 *   const slk = global.get('slk');
 *
 * Bez toho budou function nody hlásit, že "slk" je undefined.
 */
module.exports = {
  functionGlobalContext: {
    slk: require('./slk-protocol.js')
  },
  functionExternalModules: true
};
