/**
 * Node-RED settings.js pro SmartLock Gateway v Docker kontejneru.
 * Tenhle soubor musí ležet v ./data/settings.js (mountnuto jako /data/settings.js).
 *
 * Klíčové části:
 *   - userDir = '/data/' (kde leží flows.json, node_modules, gateway.db, ...)
 *   - functionGlobalContext.slk = sdílený protokolový modul (CRC, parser, builder)
 *   - functionExternalModules: true = function nody si mohou require()ovat balíky
 */
module.exports = {
    uiPort: process.env.PORT || 1880,
    flowFile: 'flows.json',
    flowFilePretty: true,
    userDir: '/data/',

    // Sdílený modul s CRC / parser / builder funkcemi.
    // Vždy přístupný ve function nodu jako:  const slk = global.get('slk');
    functionGlobalContext: {
        slk: (() => { delete require.cache[require.resolve('/data/slk-protocol.js')]; return require('/data/slk-protocol.js'); })()
    },

    // Povolit require() externích modulů ve function nodech (např. pokud bys
    // chtěl uvnitř node použít crypto, axios, lodash, ...)
    functionExternalModules: true,

    // Logging
    logging: {
        console: {
            level: "info",
            metrics: false,
            audit: false
        }
    },

    // Vypneme "Projects" feature – pro tenhle deploy nepotřebujeme git ve flow
    editorTheme: {
        projects: { enabled: false }
    }
};
