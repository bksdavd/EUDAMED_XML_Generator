const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const yaml = require('js-yaml');
const { XMLBuilder } = require('fast-xml-parser');
const SchemaContext = require('./lib/schema');
const XMLGenerator = require('./lib/generator');

const NS_MAP = {
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/v1': 'device',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/BasicUDI/v1': 'basicudi',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/UDIDI/v1': 'udidi',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/CommonDevice/v1': 'commondi',
    'http://www.w3.org/2001/XMLSchema-instance': 'xsi',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/LegacyDevice/EUDI/v1': 'eudi',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/LegacyDevice/EUDIData/v1': 'eudididata',
    'https://ec.europa.eu/tools/eudamed/dtx/servicemodel/Message/v1': 'm',
    'https://ec.europa.eu/tools/eudamed/dtx/servicemodel/Service/v1': 's',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Links/v1': 'links',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Common/LanguageSpecific/v1': 'lsn',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/MktInfo/MarketInfo/v1': 'marketinfo',
    'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/v1': 'e'
};

program
  .option('-c, --config <path>', 'Path to YAML configuration file', 'EUDAMED_data_Lens_877PAY.yaml')
  .option('-s, --schema <path>', 'Path to XSD schema file', '../EUDAMED downloaded/XSD/service/Message.xsd')
  .option('-o, --out <dir>', 'Output directory', 'output')
  .option('--type <type>', 'Specific type to generate (BasicUDI, UDIDI, All)', 'All')
  .option('--mode <mode>', 'Operation mode (POST, PATCH)', 'POST');

program.parse(process.argv);
const options = program.opts();

async function main() {
    console.log('--- EUDAMED XML Generator (Node.js) ---');
    
    // 1. Load Config
    if (!fs.existsSync(options.config)) {
        console.error(`Config file not found: ${options.config}`);
        process.exit(1);
    }
    const configRaw = yaml.load(fs.readFileSync(options.config, 'utf8'));
    const config = configRaw.defaults || {};
    console.log(`Loaded configuration from ${options.config}`);

    // 2. Load Schema
    const schemaLoader = new SchemaContext(process.cwd());
    schemaLoader.loadSchema(options.schema);
    
    // 3. Setup Generator
    // Note: Python script assumes root is Push -> payload -> MDRDevice (or similar)
    // We'll target the 'Push' element available in Message.xsd
    // And we might need to filter what we generate based on type.
    
    const generator = new XMLGenerator(schemaLoader, config, NS_MAP);
    
    const targets = [];
    if (options.type === 'All' || options.type === 'BasicUDI') targets.push('BasicUDI');
    if (options.type === 'All' || options.type === 'UDIDI') targets.push('UDIDI');
    
    if (!fs.existsSync(options.out)) {
        fs.mkdirSync(options.out, { recursive: true });
    }

    // Define substitutions (Device abstract element -> MDRDevice concrete element)
    // We assume MDRDevice is available in the schema context (loaded via imports)
    const substitutions = {
        'device:Device': 'MDRDevice' 
    };

    // 4. Generate
    for (const target of targets) {
        console.log(`Generating ${target} (${options.mode})...`);
        
        // Config filtering to isolate payloads
        const targetConfig = { ...config };
        
        if (target === 'BasicUDI') {
            // Remove UDI-DI keys
            Object.keys(targetConfig).forEach(k => {
                if (k.includes('/MDRUDIDIData') || k.includes('/MDRUDIDIData/')) {
                    delete targetConfig[k];
                }
            });
        }
        
        if (target === 'UDIDI') {
            // Remove BasicUDI keys
            Object.keys(targetConfig).forEach(k => {
                if (k.includes('/MDRBasicUDI') || k.includes('/MDRBasicUDI/')) {
                    delete targetConfig[k];
                }
            });
        }
        
        // Re-init generator with filtered config for this run
        const currentGenerator = new XMLGenerator(schemaLoader, targetConfig, NS_MAP, substitutions);

        try {
            // Pass 'Push' as explicit startPath
            const xmlObj = currentGenerator.generate('Push', 'Push');
            
            if (!xmlObj) {
                console.warn(`No content generated for ${target}. Check config and schema.`);
                continue;
            }
            
            // Build XML String
            const builder = new XMLBuilder({
                ignoreAttributes: false,
                format: true,
                suppressEmptyNode: true,
                attributeNamePrefix: "@_" 
            });
            
            const xmlContent = builder.build(xmlObj);
            console.log(`--- Generated XML Content (${target}) ---`);
            console.log(xmlContent.substring(0, 1000)); // Log first 1000 chars
            
            const fileName = `${target}_${options.mode}_output.xml`;
            const outPath = path.join(options.out, fileName);
            
            fs.writeFileSync(outPath, xmlContent);
            console.log(`Saved: ${outPath}`);
            console.log(`Preview: ${xmlContent.substring(0, 200)}...`);
            
        } catch (err) {
            console.error(`Error generating ${target}:`, err);
        }
    }
}

main().catch(err => console.error(err));
