const { XMLBuilder } = require('fast-xml-parser');

const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true,
    attributeNamePrefix: "@_" 
});

const payload = {
  "device:Device": [
    {
      "device:MDRBasicUDI": {
        "basicudi:riskClass": "CLASS_IIB"
      },
      "@_xsi:type": "device:MDRDeviceType"
    }
  ]
};

console.log('Payload Build:');
console.log(builder.build(payload));

const wrapper = {
    "m:Push": {
        "m:payload": payload
    }
};

console.log('Wrapper Build:');
console.log(builder.build(wrapper));
