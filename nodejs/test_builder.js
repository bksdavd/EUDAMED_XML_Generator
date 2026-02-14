const { XMLBuilder } = require('fast-xml-parser');

const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true,
    attributeNamePrefix: "@_" 
});

const obj = {
    'root': {
        'device:Device': [
            {
                'child': 'content',
                '@_xsi:type': 'device:MDRDeviceType'
            }
        ]
    }
};

console.log(builder.build(obj));

const obj2 = {
    'root': {
         'device:Device': {
             'child': 'content',
             '@_xsi:type': 'device:MDRDeviceType'
         }
    }
};
console.log(builder.build(obj2));
