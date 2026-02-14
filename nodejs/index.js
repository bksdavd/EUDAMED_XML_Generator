/**
 * @file index.js
 * @description Main entry point for the EUDAMED XML Generator.
 * Handles CLI arguments, configuration loading, schema resolution, and orchestration
 * of the XML generation and post-processing fixes.
 */

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const yaml = require('js-yaml');
const { XMLBuilder } = require('fast-xml-parser');
const SchemaContext = require('./lib/schema');
const XMLGenerator = require('./lib/generator');
const crypto = require('crypto');

/**
 * Initial Namespace Map for common EUDAMED/XSD prefixes.
 * This is augmented dynamically from the loaded XSD schemas.
 */
const BASE_NS_MAP = {
    'http://www.w3.org/2001/XMLSchema-instance': 'xsi',
    'https://ec.europa.eu/tools/eudamed/dtx/servicemodel/Message/v1': 'm',
    'https://ec.europa.eu/tools/eudamed/dtx/servicemodel/Service/v1': 's'
};

// --- CLI CONFIGURATION ---
program
  .option('-c, --config <path>', 'Path to YAML configuration file', './EUDAMED_data_Lens_877PAY-test.yaml')
  .option('-s, --schema <path>', 'Path to XSD schema file', '../EUDAMED downloaded/XSD/service/Message.xsd')
  .option('-o, --out <dir>', 'Output directory', 'output')
  .option('--type <type>', 'Specific type to generate (DEVICE, UDI_DI, BASIC_UDI)')
  .option('--mode <mode>', 'Operation mode (POST, PATCH)');

program.setOptionValueWithSource('mode', 'POST', 'default');
program.parse(process.argv);
const options = program.opts();

// --- INPUT VALIDATION ---
// Enforce mandatory parameters and valid service/mode combinations
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

// Check valid EUDAMED business combinations
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

// Update options with normalized values for downstream consistency
options.type = normalizedType;
options.mode = mode;

/**
 * Main orchestration function.
 */
async function main() {
    console.log('--- EUDAMED XML Generator (Node.js) ---');
    
    // 1. LOAD CONFIGURATION
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
    
    // Auto-generate unique identifiers if missing in the YAML
    if (!config['Push/messageID']) config['Push/messageID'] = crypto.randomUUID();
    if (!config['Push/correlationID']) config['Push/correlationID'] = crypto.randomUUID();
    if (!config['Push/creationDateTime']) config['Push/creationDateTime'] = new Date().toISOString();
    
    // Standard recipient settings for EUDAMED B2B exchange
    if (!config['Push/recipient/node/nodeActorCode']) config['Push/recipient/node/nodeActorCode'] = 'EUDAMED';
    
    // Set service metadata based on CLI arguments
    if (!config['Push/recipient/service/serviceID']) config['Push/recipient/service/serviceID'] = options.type;
    if (!config['Push/recipient/service/serviceOperation']) config['Push/recipient/service/serviceOperation'] = options.mode;
    
    console.log(`Loaded configuration from ${options.config}`);

    // 2. LOAD SCHEMA CONTEXT
    const schemaLoader = new SchemaContext(process.cwd());
    schemaLoader.loadSchema(options.schema);
    const extractedNamespaces = schemaLoader.getNamespaces();
    
    // 3. SETUP GENERATOR
    // Merge base namespace prefixes with those found in the XSD files
    const nsMap = { ...BASE_NS_MAP };
    if (extractedNamespaces) {
        Object.entries(extractedNamespaces).forEach(([prefix, uri]) => {
            if (!nsMap[uri]) {
                 nsMap[uri] = prefix;
            }
        });
    }

    const generator = new XMLGenerator(schemaLoader, config, nsMap);
    
    if (!fs.existsSync(options.out)) {
        fs.mkdirSync(options.out, { recursive: true });
    }

    // 4. GENERATION PHASE
    console.log(`Generating ${options.type} (${options.mode})...`);
    
    // Element mapping to handle abstract 'device:Device' in EUDAMED schema
    const substitutions = {
        'device:Device': 'MDRDevice'
    };

    const targetConfig = { ...config };
    const currentGenerator = new XMLGenerator(schemaLoader, targetConfig, nsMap, substitutions);

    try {
        let xmlObj = null;
        
        // Target specific payload fragments based on the EUDAMED service type
        const serviceID = options.type;

        if (serviceID === 'BASIC_UDI') {
             // Generate MDRBasicUDI fragment and override type to allow patching
             xmlObj = currentGenerator.generate('BasicUDI', 'Push/payload/MDRDevice/MDRBasicUDI', null, 'basicudi:MDRBasicUDIType');
        } else if (serviceID === 'UDI_DI') {
             // Generate MDRUDIDIData fragment
             xmlObj = currentGenerator.generate('UDIDIData', 'Push/payload/MDRDevice/MDRUDIDIData', null, 'udidi:MDRUDIDIDataType');
        } else if (serviceID === 'DEVICE') {
             // Generate full Push message (Bulk registration)
             xmlObj = currentGenerator.generate('Push', 'Push');
        }
        
        // 5. WRAPPING (for fragmentary payloads)
        // If the service is not 'DEVICE' (full registration), we wrap the generated fragment
        // in a standard 'm:Push' envelope with corrected headers.
        if (serviceID !== 'DEVICE') { 
            if (xmlObj) {
                     const pushContent = {
                             '@_version': '3.0.25'
                     };
                     
                     // Header ordering is critical for schema validation
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
                     
                     // Sender block initialization
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

                     // Dynamic namespace injection into the Push element
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
                // For DEVICE registrations, inject namespaces directly into the root generated object
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
                console.warn(`No content generated for ${options.type}. Check config and schema.`);
                return;
            }

            // --- 6. POST-PROCESSING FIXES ---
            // This function handles structural fixes that are difficult to express in the recursive generator:
            // - Substitution of abstract elements (MDRDevice -> Device with xsi:type)
            // - Mandatory element ordering (Base fields before extensions)
            // - Removal of versioning info for POST operations
            
            function recursiveFix(obj) {
                if (!obj || typeof obj !== 'object') return;
                
                Object.keys(obj).forEach(key => {
                    // Fix: Remove internal metadata versioning for initial POST registrations
                    if (options.mode === 'POST') {
                        const localKey = key.includes(':') ? key.split(':')[1] : key;
                        if (['version', 'state', 'versionDate'].includes(localKey)) {
                            delete obj[key];
                            return;
                        }
                    }

                    // Fix: Element Substitution for Device hierarchy
                    if (key.endsWith('MDRDevice')) {
                        const val = obj[key];
                        const prefix = key.split(':')[0];
                        const newKey = prefix && prefix !== key ? `${prefix}:Device` : 'Device';
                        
                        const items = Array.isArray(val) ? val : [val];
                        
                        items.forEach(item => {
                            if (item && typeof item === 'object') {
                                if (item['@_xsi:type']) delete item['@_xsi:type'];
                                item['@_xsi:type'] = `${prefix || 'device'}:MDRDeviceType`;
                                recursiveFix(item);
                            }
                        });
                        
                        obj[newKey] = Array.isArray(val) ? val : val; 
                        delete obj[key];
                        return; 
                    }
                    
                    // Fix: Ensure Sender node has its mandatory Service block
                    if (key.endsWith('sender')) {
                        const sender = obj[key];
                        const hasService = Object.keys(sender).some(k => k.endsWith('service') && !k.endsWith('erviceOperation') && !k.endsWith('erviceID'));
                        
                        if (!hasService && typeof sender === 'object') {
                             sender['m:service'] = {
                                's:serviceID': options.type,
                                's:serviceOperation': options.mode
                            };
                            if (sender['s:service']) delete sender['s:service'];
                        } else if (sender['s:service']) {
                             sender['m:service'] = sender['s:service'];
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

                    // Fix: SEQUENCE ORDERING
                    // EUDAMED XSD requires elements in a specific order (base before extension).
                    // This logic maintains the correct sequence for UDI types.
                    if (key.endsWith('BasicUDI') || key.endsWith('UDIDIData')) {
                        const udi = obj[key];
                        if (udi && typeof udi === 'object') {
                            const newUdi = {};
                            let correctOrder = [];

                            if (key.endsWith('BasicUDI')) {
                                correctOrder = [
                                    // Entity.xsd (Base)
                                    'state', 'version', 'versionDate',
                                    // BasicUDIType.xsd
                                    'riskClass', 'model', 'modelName', 'identifier', 'certificateLinks',
                                    // DeviceBasicUDIType.xsd
                                    'animalTissuesCells', 'ARActorCode', 'humanTissuesCells', 'MFActorCode', 'ARComments',
                                    'clinicalInvestigationLinks', 'deviceCertificateLinks',
                                    // MDRBasicUDIType.xsd
                                    'humanProductCheck', 'IIb_implantable_exceptions', 'medicinalProductCheck', 'specialDevice', 'type',
                                    // MDApplicablePropertiesGroup.xsd
                                    'active', 'administeringMedicine', 'implantable', 'measuringFunction', 'reusable'
                                ];
                            } else {
                                // UDIDIData Sequence
                                correctOrder = [
                                    // Entity.xsd (Base)
                                    'state', 'version', 'versionDate',
                                    // UDIDIType.xsd
                                    'identifier', 'status',
                                    // UDIDIDataType.xsd
                                    'additionalDescription', 'basicUDIIdentifier', 'MDNCodes', 'productionIdentifier',
                                    'referenceNumber', 'secondaryIdentifier', 'sterile', 'sterilization', 'tradeNames', 'website',
                                    'storageHandlingConditions', 'packages', 'criticalWarnings', 'substatuses',
                                    // DeviceUDIDIDataType.xsd
                                    'numberOfReuses', 'relatedUDILink', 'marketInfos', 'deviceMarking', 'baseQuantity', 'productDesignerActor',
                                    // MDRUDIDIDataType.xsd
                                    'annexXVINonMedicalDeviceTypes', 'annexXVIApplicable', 'latex', 'reprocessed'
                                ];
                            }

                            // Re-insert properties into a new object in the specified order
                            correctOrder.forEach(prop => {
                                const propKey = Object.keys(udi).find(k => k.endsWith(`:${prop}`) || k === prop);
                                if (propKey) {
                                    newUdi[propKey] = udi[propKey];
                                    delete udi[propKey];
                                }
                            });
                            
                            // Append any remaining/dynamic properties (e.g., xsi:type)
                            Object.assign(newUdi, udi);
                            obj[key] = newUdi;
                            
                            recursiveFix(newUdi);
                            return;
                        }
                    }
                    
                    // Recursive call for nested structures
                    if (obj[key]) recursiveFix(obj[key]);
                });
            }
            
            // Execute post-processing
            recursiveFix(xmlObj);

            // 7. XML BUILDING
            const builder = new XMLBuilder({
                ignoreAttributes: false,
                format: true,
                suppressEmptyNode: true,
                attributeNamePrefix: "@_" 
            });
            
            const xmlContent = builder.build(xmlObj);
            console.log(`--- Generated XML Content (${options.type}) ---`);
            console.log(xmlContent.substring(0, 1000));
            
            // 8. FINAL OUTPUT
            // Generate filename based on type and mode (e.g., UDI_DI-POST.xml)
            const safeType = options.type.replace(/[^a-zA-Z0-9_\-]/g, '');
            const fileName = `${safeType}-${options.mode}.xml`;
            const outPath = path.join(options.out, fileName);
            
            fs.writeFileSync(outPath, xmlContent);
            console.log(`Saved: ${outPath}`);
            console.log(`Preview: ${xmlContent.substring(0, 200)}...`);
            
        } catch (err) {
            console.error(`Error generating ${options.type}:`, err);
        }
}

// Global error handler for the main execution pipeline
main().catch(err => console.error(err));
