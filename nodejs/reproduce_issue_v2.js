
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const SchemaContext = require('./lib/schema');
const XMLGenerator = require('./lib/generator');

// Mock Config
const config = {
  'Push/payload/MDRDevice/MDRUDIDIData/numberOfReuses': 0,
  'Push/payload/MDRDevice/MDRUDIDIData/identifier/DICode': '05993026538013',
  'Push/payload/MDRDevice/MDRUDIDIData/identifier/issuingEntityCode': 'GS1',
  'Push/payload/MDRDevice/MDRUDIDIData/status/code': 'ON_THE_MARKET'
};

const NS_MAP = {
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/v1': 'device',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/BasicUDI/v1': 'basicudi',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/UDIDI/v1': 'udidi',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/CommonDevice/v1': 'commondi',
    'http://www.w3.org/2001/XMLSchema-instance': 'xsi'
};

const schemaLoader = new SchemaContext(path.resolve(__dirname, '..'));
// Load DI.xsd using absolute path or relative to root
schemaLoader.loadSchema('EUDAMED downloaded/XSD/data/Entity/DI.xsd');

const generator = new XMLGenerator(schemaLoader, config, NS_MAP);
generator.debug = true; 

generator.substitutions = {
    'device:Device': 'MDRDevice'
};

console.log("--- Generating MDRDevice ---");
try {
    const result = generator.generate('MDRDevice', 'Push/payload/MDRDevice');
    console.log("RESULT:", JSON.stringify(result, null, 2));
} catch (e) {
    console.error(e);
}
