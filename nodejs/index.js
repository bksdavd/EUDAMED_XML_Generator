const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const yaml = require('js-yaml');
const { XMLBuilder } = require('fast-xml-parser');
const SchemaContext = require('./lib/schema');
const XMLGenerator = require('./lib/generator');
const crypto = require('crypto');

// Initial NS_MAP with common overrides if needed, valid defaults.
// We will augment this with extracted namespaces from schema.
const BASE_NS_MAP = {
    'http://www.w3.org/2001/XMLSchema-instance': 'xsi',
    'https://ec.europa.eu/tools/eudamed/dtx/servicemodel/Message/v1': 'm',
    'https://ec.europa.eu/tools/eudamed/dtx/servicemodel/Service/v1': 's'
};

program
  .option('-c, --config <path>', 'Path to YAML configuration file', 'EUDAMED_data_Lens_877PAY.yaml')
  .option('-s, --schema <path>', 'Path to XSD schema file', '../EUDAMED downloaded/XSD/service/Message.xsd')
  .option('-o, --out <dir>', 'Output directory', 'output')
  .option('--type <type>', 'Specific type to generate (DEVICE, UDI_DI, BASIC_UDI)')
  .option('--mode <mode>', 'Operation mode (POST, PATCH)');

program.setOptionValueWithSource('mode', 'POST', 'default');
program.parse(process.argv);
const options = program.opts();

// --- INPUT VALIDATION ---
if (!options.type) {
    console.error('Error: --type parameter is required (DEVICE, UDI_DI, or BASIC_UDI)');
    process.exit(1);
}

const validTypes = ['DEVICE', 'UDI_DI', 'BASIC_UDI'];
const normalizedType = options.type.toUpperCase().replace('-', '_');

if (!validTypes.includes(normalizedType)) {
    console.error(`Error: Invalid type '${options.type}'. Supported types: ${validTypes.join(', ')}`);
    process.exit(1);
}

const validModes = ['POST', 'PATCH'];
const mode = options.mode ? options.mode.toUpperCase() : 'POST';

if (!validModes.includes(mode)) {
    console.error(`Error: Invalid mode '${options.mode}'. Supported modes: ${validModes.join(', ')}`);
    process.exit(1);
}

// Check valid combinations
const validCombinations = {
    'DEVICE': ['POST'],
    'UDI_DI': ['POST', 'PATCH'],
    'BASIC_UDI': ['PATCH']
};

if (!validCombinations[normalizedType].includes(mode)) {
    console.error(`Error: Invalid combination. Type '${normalizedType}' does not support mode '${mode}'.`);
    console.error(`Supported modes for ${normalizedType}: ${validCombinations[normalizedType].join(', ')}`);
    process.exit(1);
}

// Update options with normalized values
options.type = normalizedType;
options.mode = mode;

async function main() {
    console.log('--- EUDAMED XML Generator (Node.js) ---');
    
    // 1. Load Config
    if (!fs.existsSync(options.config)) {
        // Try relative to previous cwd if fail
         if (!fs.existsSync(path.resolve(__dirname, options.config))) {
             console.error(`Config file not found: ${options.config}`);
             process.exit(1);
         } else {
             options.config = path.resolve(__dirname, options.config);
         }
    }
    const configRaw = yaml.load(fs.readFileSync(options.config, 'utf8'));
    const config = configRaw.defaults || {};
    
    // Header Auto-generation
    // If config is missing these keys, generate random ones.
    if (!config['Push/messageID']) config['Push/messageID'] = crypto.randomUUID();
    if (!config['Push/correlationID']) config['Push/correlationID'] = crypto.randomUUID();
    if (!config['Push/creationDateTime']) config['Push/creationDateTime'] = new Date().toISOString();
    
    // Recipient Hardcoding if missing (Common pattern)
    if (!config['Push/recipient/node/nodeActorCode']) config['Push/recipient/node/nodeActorCode'] = 'EUDAMED';
    
    // Dynamic Service ID default based on input type if provided before falling back to DEVICE
    let defaultServiceID = 'DEVICE';
    if (options.type) {
        defaultServiceID = options.type; // Use the raw input type (e.g. BASIC_UDI or UDI_DI)
    }

    if (!config['Push/recipient/service/serviceID']) config['Push/recipient/service/serviceID'] = defaultServiceID;
    if (!config['Push/recipient/service/serviceOperation']) config['Push/recipient/service/serviceOperation'] = options.mode; // POST/PATCH
    
    console.log(`Loaded configuration from ${options.config}`);

    // 2. Load Schema
    const schemaLoader = new SchemaContext(process.cwd());
    schemaLoader.loadSchema(options.schema);
    const extractedNamespaces = schemaLoader.getNamespaces();
    
    // 3. Setup Generator
    // Construct dynamic NS_MAP from extracted namespaces (URI -> Prefix)
    // Preference given to BASE_NS_MAP
    const nsMap = { ...BASE_NS_MAP };
    if (extractedNamespaces) {
        Object.entries(extractedNamespaces).forEach(([prefix, uri]) => {
            // If the URI is NOT already mapped, add it.
            if (!nsMap[uri]) {
                 nsMap[uri] = prefix;
            }
        });
    }

    // Also ensure the hardcoded ones from original map are covered if extraction failed or was incomplete?
    // The previous hardcoded list had many. Let's trust the schema extraction now plus base overrides.

    const generator = new XMLGenerator(schemaLoader, config, nsMap);
    
    // Direct mapping: The user provides the TYPE (Service ID) directly.
    // e.g., 'DEVICE' (for BasicUDI POST), 'UDI-DI' (for UDI POST), 'BASIC_UDI' (for BasicUDI PATCH)
    // We map this to our internal generation targets.
    
    let internalTarget = 'BasicUDI'; // Default fallback
    if (options.type === 'UDI-DI' || options.type === 'UDI_DI') {
        internalTarget = 'UDIDI';
    } else if (options.type === 'DEVICE' || options.type === 'BASIC_UDI') {
        internalTarget = 'BasicUDI'; // DEVICE usually implies BasicUDI context in simple mode
    } else {
        // Fallback for direct internal names if used
        internalTarget = options.type;
    }

    const targets = [internalTarget];
    
    if (!fs.existsSync(options.out)) {
        fs.mkdirSync(options.out, { recursive: true });
    }

    // Define substitutions (Device abstract element -> MDRDevice concrete element)
    // We assume MDRDevice is available in the schema context (loaded via imports)

    // 4. Generate
    for (const target of targets) {
        console.log(`Generating ${target} from input type '${options.type}' (${options.mode})...`);
        
        // Use substitutions to force generation of concrete MDRDevice content
        // Then post-processing will rename it back to Device with xsi:type
        const substitutions = {
            'device:Device': 'MDRDevice'
        };

        // Config filtering to isolate payloads
        // optimization: For 'BasicUDI', we generally want MDRDevice which might include UDIDI data for a Full Device Post.
        // We will only strictly filter if the user explicitly requested a split (not implemented here) or if we want to enforce separation.
        // Given the user feedback, we'll allow UDIDI data in BasicUDI generation if present in config.
        
        const targetConfig = { ...config };
        
        /* 
           Disabled filtering to allow full Device payloads.
           The generator will only generate what is in the config map.
           If the user supplies config for UDIDI, it will appear in the output if the Schema allows it (MDRDevice allows both).
        */
        if (target === 'BasicUDI' && false) {
             // ... kept for reference but disabled
        }
        
        /*
        if (target === 'UDIDI') {
            // Remove BasicUDI keys
            Object.keys(targetConfig).forEach(k => {
                if (k.includes('/MDRBasicUDI') || k.includes('/MDRBasicUDI/')) {
                    delete targetConfig[k];
                }
            });
        }
        */
        
        // Re-init generator with filtered config for this run
        const currentGenerator = new XMLGenerator(schemaLoader, targetConfig, nsMap, substitutions);

        try {
            let xmlObj = null;
            
            // Determine Root Element based on Service ID and Mode
            // DEVICE -> device:Device (MDRDevice)
            // BASIC_UDI -> device:BasicUDI (MDRBasicUDI) - usually PATCH
            // UDI-DI -> device:UDIDIData (MDRUDIDIData) - POST or PATCH?
            
            // Logic derived from user requests:
            // DEVICE/POST -> Device
            // BASIC_UDI/PATCH -> BasicUDI
            // UDI_DI/POST -> UDIDIData (User says only UDI_DI block needed)
            // UDI_DI/PATCH -> UDIDIData
            
            let serviceID = options.type.toUpperCase();
            if (serviceID === 'BASICUDI' || serviceID === 'BASIC-UDI') serviceID = 'BASIC_UDI';
            if (serviceID === 'UDIDI' || serviceID === 'UDI-DI') serviceID = 'UDI_DI';

            if (serviceID === 'BASIC_UDI' || (options.mode === 'PATCH' && target === 'BasicUDI')) {
                 // Use EXACT element name from MessageType.xsd choice (BasicUDI)
                 xmlObj = currentGenerator.generate('BasicUDI', 'Push/payload/MDRDevice/MDRBasicUDI', null, 'basicudi:MDRBasicUDIType');
            } else if (serviceID === 'UDI_DI' || (options.mode === 'PATCH' && target === 'UDIDI')) {
                 // Use EXACT element name from MessageType.xsd choice (UDIDIData)
                 xmlObj = currentGenerator.generate('UDIDIData', 'Push/payload/MDRDevice/MDRUDIDIData', null, 'udidi:MDRUDIDIDataType');
            } else if (serviceID === 'DEVICE') {
                 // Full Device is the payload
                 xmlObj = currentGenerator.generate('Push', 'Push');
            } else {
                 // Fallback to default Push generation (Device)
                 xmlObj = currentGenerator.generate('Push', 'Push');
            }
            
            // If we generated a fragmentary payload (not starting from Push), wrap it manually
            if (serviceID !== 'DEVICE') { // Assuming DEVICE uses standard Push gen
                if (xmlObj) {
                     // Need headers - Order matters for XSD validation!
                     const pushContent = {
                             '@_version': '3.0.25'
                     };
                     
                     if (config['Push/conversationID']) pushContent['m:conversationID'] = config['Push/conversationID'];
                     pushContent['m:correlationID'] = config['Push/correlationID'];
                     pushContent['m:creationDateTime'] = config['Push/creationDateTime'];
                     pushContent['m:messageID'] = config['Push/messageID'];
                     
                     const recipientNode = {
                         's:nodeActorCode': config['Push/recipient/node/nodeActorCode'] || 'EUDAMED'
                     };
                     if (config['Push/recipient/node/nodeID']) {
                         recipientNode['s:nodeID'] = config['Push/recipient/node/nodeID'];
                     } else if (serviceID !== 'DEVICE') {
                         // Keep the standard default for EUDAMED node if not DEVICE mode
                         recipientNode['s:nodeID'] = 'eDelivery:EUDAMED';
                     }

                     const recipientService = {
                         's:serviceID': serviceID,
                         's:serviceOperation': options.mode 
                     };
                     if (config['Push/header/security_token']) {
                         recipientService['s:serviceAccessToken'] = config['Push/header/security_token'];
                     }

                     pushContent['m:recipient'] = {
                         'm:node': recipientNode,
                         'm:service': recipientService
                     };
                     
                     pushContent['m:payload'] = xmlObj;
                     
                     // Sender block
                     const senderNode = {};
                     if (config['Push/sender/node/nodeActorCode']) {
                         senderNode['s:nodeActorCode'] = config['Push/sender/node/nodeActorCode'];
                     }
                     if (config['Push/header/party_id']) {
                         senderNode['s:nodeID'] = config['Push/header/party_id'];
                     }

                     pushContent['m:sender'] = {
                         'm:node': senderNode,
                         'm:service': {
                             's:serviceID': serviceID,
                             's:serviceOperation': options.mode
                         }
                     };

                     // Inject extracted namespaces dynamically
                     if (extractedNamespaces) {
                         Object.entries(extractedNamespaces).forEach(([prefix, uri]) => {
                             pushContent[`@_xmlns:${prefix}`] = uri;
                         });
                     }

                     xmlObj = {
                         'm:Push': pushContent
                     };
                }
            } else {
                // For DEVICE/Push generation, allow standard flow but we might need to fix root namespaces if not already there
                // Inject extracted namespaces into the generated root element for POST/Default (DEVICE)
                if (xmlObj && extractedNamespaces) {
                    const rootKey = Object.keys(xmlObj)[0];
                    if (rootKey && xmlObj[rootKey] && typeof xmlObj[rootKey] === 'object') {
                        Object.entries(extractedNamespaces).forEach(([prefix, uri]) => {
                             const attrName = `@_xmlns:${prefix}`;
                             xmlObj[rootKey][attrName] = uri;
                        });
                    }
                }
            }
            
            if (!xmlObj) {
                console.warn(`No content generated for ${target}. Check config and schema.`);
                continue;
            }

            // --- POST-PROCESSING FIXES ---
            // 1. Rename 'MDRDevice' to 'Device' and add xsi:type
            // 2. Ensure 'sender' has 'service'
            // 3. Fix property order for BasicUDI (schema requires specific sequence)
            
            function recursiveFix(obj) {
                if (!obj || typeof obj !== 'object') return;
                
                Object.keys(obj).forEach(key => {
                    // Fix 0: Remove version info for POST services (schemas allow 0 minOccurs, usually not allowed/needed in POST)
                    if (options.mode === 'POST') {
                        const localKey = key.includes(':') ? key.split(':')[1] : key;
                        if (['version', 'state', 'versionDate'].includes(localKey)) {
                            delete obj[key];
                            return;
                        }
                    }

                    // Fix 1: Root Element Substitution
                    if (key.endsWith('MDRDevice')) {
                        const val = obj[key];
                        // Prefix might vary, but let's assume 'device' or matching prefix
                        const prefix = key.split(':')[0];
                        const newKey = prefix && prefix !== key ? `${prefix}:Device` : 'Device';
                        
                        // Handle Array vs Object for unbounded elements
                        const items = Array.isArray(val) ? val : [val];
                        
                        items.forEach(item => {
                            if (item && typeof item === 'object') {
                                // Explicitly remove any existing type (unlikely but safe)
                                if (item['@_xsi:type']) delete item['@_xsi:type'];
                                
                                // Set specific type
                                item['@_xsi:type'] = `${prefix || 'device'}:MDRDeviceType`;
                                
                                recursiveFix(item);
                            }
                        });
                        
                        // Force assignment - although mutate-in-place works for objects
                        obj[newKey] = Array.isArray(val) ? val : val; 
                        delete obj[key];
                        return; 
                    }
                    
                    // Fix 2: Sender Service
                    if (key.endsWith('sender')) {
                        console.log('DEBUG: Found sender key:', key);
                        const sender = obj[key];
                        // Ensure sender has service block using 'm:service' not 's:service' (element mismatch fix)
                        const hasService = Object.keys(sender).some(k => k.endsWith('service') && !k.endsWith('erviceOperation') && !k.endsWith('erviceID'));
                        
                        console.log('DEBUG: sender keys:', Object.keys(sender));

                        if (!hasService && typeof sender === 'object') {
                             sender['m:service'] = {
                                's:serviceID': options.type, // Map input type directly to Service ID
                                's:serviceOperation': options.mode
                                // Namespace s is usually at root, but can be here if needed
                            };
                            // If we generated 's:service' before, remove it if it exists and is wrong
                            if (sender['s:service']) delete sender['s:service'];
                        } else if (sender['s:service']) {
                             console.log('DEBUG: Renaming s:service to m:service');
                             // Correct existing bad key s:service -> m:service
                             sender['m:service'] = sender['s:service'];
                             
                             // Overwrite service ID with input type
                             sender['m:service']['s:serviceID'] = options.type;

                             delete sender['s:service'];
                        } else if (sender['service']) {
                            // If it exists as 'service', rename to 'm:service'
                            sender['m:service'] = sender['service'];
                            
                             // Overwrite service ID with input type
                             sender['m:service']['s:serviceID'] = options.type;

                            delete sender['service'];
                        }
                    }

                    // Fix 3: Sequence Order
                    if (key.endsWith('BasicUDI') || key.endsWith('UDIDIData')) {
                        const udi = obj[key];
                        if (udi && typeof udi === 'object') {
                            const newUdi = {};
                            let correctOrder = [];

                            if (key.endsWith('BasicUDI')) {
                                correctOrder = [
                                    // Entity (Base)
                                    'state', 'version', 'versionDate',
                                    // BasicUDIType
                                    'riskClass', 'model', 'modelName', 'identifier', 'certificateLinks',
                                    // DeviceBasicUDIType
                                    'animalTissuesCells', 'ARActorCode', 'humanTissuesCells', 'MFActorCode', 'ARComments',
                                    'clinicalInvestigationLinks', 'deviceCertificateLinks',
                                    // MDRBasicUDIType
                                    'humanProductCheck', 'IIb_implantable_exceptions', 'medicinalProductCheck', 'specialDevice', 'type',
                                    // MDApplicablePropertiesGroup
                                    'active', 'administeringMedicine', 'implantable', 'measuringFunction', 'reusable'
                                ];
                            } else {
                                // UDIDIData
                                correctOrder = [
                                    // Entity (Base)
                                    'state', 'version', 'versionDate',
                                    // UDIDIType
                                    'identifier', 'status',
                                    // UDIDIDataType
                                    'additionalDescription', 'basicUDIIdentifier', 'MDNCodes', 'productionIdentifier',
                                    'referenceNumber', 'secondaryIdentifier', 'sterile', 'sterilization', 'tradeNames', 'website',
                                    'storageHandlingConditions', 'packages', 'criticalWarnings', 'substatuses',
                                    // DeviceUDIDIDataType
                                    'numberOfReuses', 'relatedUDILink', 'marketInfos', 'deviceMarking', 'baseQuantity', 'productDesignerActor',
                                    // MDRUDIDIDataType
                                    'annexXVINonMedicalDeviceTypes', 'annexXVIApplicable', 'latex', 'reprocessed'
                                ];
                            }

                            correctOrder.forEach(prop => {
                                const propKey = Object.keys(udi).find(k => k.endsWith(`:${prop}`) || k === prop);
                                if (propKey) {
                                    newUdi[propKey] = udi[propKey];
                                    delete udi[propKey];
                                }
                            });
                            
                            // Add remaining
                            Object.assign(newUdi, udi);
                            obj[key] = newUdi;
                            
                            recursiveFix(newUdi);
                            return;
                        }
                    }
                    
                    // Recurse
                    if (obj[key]) recursiveFix(obj[key]);
                });
            }
            
            recursiveFix(xmlObj);

            // Build XML String
            const builder = new XMLBuilder({
                ignoreAttributes: false,
                format: true,
                suppressEmptyNode: true,
                attributeNamePrefix: "@_" 
            });
            
            // Debug: Check if attributes are present in final object
            // Log payload structure deeply
            if (options.mode === 'POST' && target === 'BasicUDI') {
                console.log('DEBUG: Full Push structure before build:', JSON.stringify(xmlObj, null, 2));
            }

            const xmlContent = builder.build(xmlObj);
            console.log(`--- Generated XML Content (${target}) ---`);
            console.log(xmlContent.substring(0, 1000)); // Log first 1000 chars
            
            // Use CLI type for filename as requested (e.g. DEVICE-POST.xml)
            const safeType = options.type.replace(/[^a-zA-Z0-9_\-]/g, '');
            const fileName = `${safeType}-${options.mode}.xml`;
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
