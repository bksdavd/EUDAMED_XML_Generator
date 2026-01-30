import os
import sys
import xml.etree.ElementTree as ET
import streamlit as st
import xmlschema
import yaml
import re
import csv
import io

# Page configuration
st.set_page_config(page_title="EUDAMED XML Generator", layout="wide")
st.title("EUDAMED XML Generator")

def load_config(product_group):
    """Load YAML configuration for the selected product group."""
    if not product_group:
        return {}, {}
        
    filename = f"EUDAMED_data_{product_group}.yaml"
    base_dir = os.path.dirname(os.path.abspath(__file__))
    file_path = os.path.join(base_dir, filename)
    
    if not os.path.exists(file_path):
        return None, None # Signal missing file
        
    try:
        with open(file_path, 'r') as f:
            data = yaml.safe_load(f) or {}
            return data.get('visible_fields', []), data.get('defaults', {})
    except Exception as e:
        st.error(f"Error loading config {filename}: {e}")
        return [], {}

@st.cache_resource
def load_eudamed_metadata():
    """Load and cache metadata from EUDAMED CSV files."""
    metadata = {}
    all_headers = set()
    base_dir = os.path.dirname(os.path.abspath(__file__))
    csv_dir = os.path.join(base_dir, 'EUDAMED downloaded')
    
    files = ['basic-udi.csv', 'udi-di.csv']
    
    for filename in files:
        path = os.path.join(csv_dir, filename)
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
                    # csv.DictReader might struggle if headers have BOM or spaces
                    # Read first line to clean headers
                    lines = f.readlines()
                    if not lines: continue
                    
                    # Use csv.reader to correctly parse headers (handles quotes)
                    header_reader = csv.reader([lines[0]])
                    raw_headers = next(header_reader)
                    
                    # Filter empty headers
                    headers = [h.strip() for h in raw_headers if h and h.strip()]
                    all_headers.update(headers)
                    
                    # Use the cleaned headers
                    reader = csv.DictReader(lines[1:], fieldnames=headers)
                    
                    for row in reader:
                        # Find the Field ID (it might be 'Field ID' or 'Field ID ' etc)
                        # We cleaned headers so it should be 'Field ID'
                        fld_id = row.get('Field ID')
                        if fld_id:
                            metadata[fld_id] = row
            except Exception as e:
                st.error(f"Error loading metadata from {filename}: {e}")
                
    # Sort headers to ensure consistent order
    sorted_headers = sorted(list(all_headers))
    # Make sure Field ID is present if not
    if 'Field ID' in sorted_headers:
         sorted_headers.remove('Field ID')
        
    return metadata, sorted_headers

@st.cache_resource
def load_schema():
    """Load and cache the XML schema."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    xsd_path = os.path.join(base_dir, 'EUDAMED downloaded', 'XSD', 'data', 'Entity', 'DI.xsd')
    
    if not os.path.exists(xsd_path):
        return None, f"Schema file not found at: {xsd_path}"

    try:
        schema = xmlschema.XMLSchema(xsd_path)
        return schema, None
    except Exception as e:
        return None, f"Failed to load schema: {e}"

def get_enums_for_type(type_obj):
    """Extract enumeration values from a type object."""
    enums = None
    if type_obj.is_simple():
        if hasattr(type_obj, 'enumeration') and type_obj.enumeration:
            enums = type_obj.enumeration
        elif hasattr(type_obj, 'base_type') and hasattr(type_obj.base_type, 'enumeration') and type_obj.base_type.enumeration:
             enums = type_obj.base_type.enumeration
    return [str(e) for e in enums] if enums else None

def get_type_constraints_help(type_obj):
    """Generate a help string for type constraints."""
    constraints = []
    if hasattr(type_obj, 'min_length') and type_obj.min_length is not None:
        constraints.append(f"Min Length: {type_obj.min_length}")
    if hasattr(type_obj, 'max_length') and type_obj.max_length is not None:
        constraints.append(f"Max Length: {type_obj.max_length}")
    if hasattr(type_obj, 'patterns') and type_obj.patterns:
         constraints.append(f"Pattern required")
    
    return " | ".join(constraints) if constraints else ""

def get_documentation(obj):
    """Extract documentation from an XSD component."""
    docs = []
    
    # helper to extract text safely
    def extract_text(doc):
        if isinstance(doc, str):
            return doc
        if hasattr(doc, 'text'):
            return doc.text
        # Fallback for lxml/ElementTree elements
        return getattr(doc, 'text', str(doc))

    try:
        if hasattr(obj, 'annotation') and obj.annotation is not None:
             if hasattr(obj.annotation, 'documentation') and obj.annotation.documentation:
                 for doc in obj.annotation.documentation:
                     txt = extract_text(doc)
                     if txt:
                         docs.append(txt.strip())
    except Exception as e:
        print(f"Error extracting documentation: {e}")
        
    return docs

def render_input_fields(element, type_obj, parent_key, state_container, xml_path="", config_visible=None, config_defaults=None, metadata=None):
    """
    Recursively renders input fields for an element.
    Returns the value entered/selected by the user.
    """
    indent_level = len(parent_key.split(".")) if parent_key else 0
    key = f"{parent_key}.{element.name}" if parent_key else element.name
    
    current_path = f"{xml_path}/{element.local_name}" if xml_path else element.local_name
    
    # Store the structure in session state to rebuild XML later
    if 'xml_structure' not in state_container:
        state_container['xml_structure'] = {}

    if type_obj.is_simple():
        # Configuration Visibility Check
        # True if config is not loaded (None) or if path is in visible list
        # OR if element is mandatory (min_occurs >= 1)
        is_mandatory = getattr(element, 'min_occurs', 1) >= 1
        is_visible = config_visible is None or current_path in config_visible or is_mandatory
        
        # Default Value
        default_val = None
        if config_defaults:
            default_val = config_defaults.get(current_path)

        # Logic: If hidden, try to return default, else return None (skip)
        if not is_visible:
            if default_val is not None:
                return str(default_val)
            # If mandatory (min_occurs >= 1) but hidden and no default -> Warning? Or skip?
            # We skip it. Validation will catch it later if it was critical.
            return None

        enums = get_enums_for_type(type_obj)
        label = f"{element.local_name}"
        
        # Display XML Path
        st.caption(f"📍 Path: `{current_path}`")
        
        # Build help text with documentation
        help_lines = []
        
        # 1. Try element annotation
        element_docs = get_documentation(element)
        if element_docs:
            help_lines.extend(element_docs)
        
        # 2. Try type annotation if element has none
        if not element_docs:
            type_docs = get_documentation(type_obj)
            if type_docs:
                help_lines.extend(type_docs)

        # Extract FLD codes
        temp_help_text = "\n".join(help_lines)
        fld_codes = re.findall(r"#(FLD.*?)#", temp_help_text)
        
        # Fetch Metadata
        meta_info = {}
        if metadata and fld_codes:
            for code in fld_codes:
                if code in metadata:
                    row = metadata[code]
                    meta_info[code] = row
                    # Append info to help lines
                    help_lines.append(f"--- Metadata for {code} ---")
                    if row.get('Field Label'):
                        help_lines.append(f"Label: {row['Field Label']}")
                    if row.get('Field Description / Notes'):
                        help_lines.append(f"Description: {row['Field Description / Notes']}")
                    if row.get('Business Rules'):
                        help_lines.append(f"Rules: {row['Business Rules']}")
        
        help_lines.append(f"Namespace: {element.name}")
        
        constraint_text = get_type_constraints_help(type_obj)
        if constraint_text:
            help_lines.append(f"Constraints: {constraint_text}")
            
        help_text = "\n\n".join(help_lines)
        
        val = None
        if enums:
            # Handle index for default value in selectbox
            default_idx = 0
            if default_val and str(default_val) in enums:
                default_idx = enums.index(str(default_val))
                
            val = st.selectbox(label, options=enums, index=default_idx, key=key, help=help_text)
        elif hasattr(type_obj, 'primitive_type') and type_obj.primitive_type and type_obj.primitive_type.local_name == 'boolean':
             # Handle Boolean
             # Default value check
             is_checked = False
             if default_val is not None:
                 if isinstance(default_val, bool):
                     is_checked = default_val
                 elif str(default_val).lower() == 'true':
                     is_checked = True
            
             bool_val = st.toggle(label, value=is_checked, key=key, help=help_text)
             val = "true" if bool_val else "false"
        else:
            # Check for max length for the input widget
            max_chars = None
            if hasattr(type_obj, 'max_length') and type_obj.max_length is not None:
                max_chars = int(type_obj.max_length)
             
            # Default value
            input_val = str(default_val) if default_val is not None else ""
                
            val = st.text_input(label, value=input_val, key=key, help=help_text, max_chars=max_chars)
        
        # Validation Logic
        if val:
            # Use xmlschema's own validation to check the value
            try:
                type_obj.validate(val)
            except xmlschema.XMLSchemaValidationError as e:
                st.error(f"❌ Invalid format: {e.reason}")
            except Exception as e:
                st.error(f"❌ Invalid value")
            
            # Record data for CSV Export
            fld_code_str = ", ".join(fld_codes) if fld_codes else ""
            
            # Base entry
            csv_entry = {
                'XMLPath': current_path,
                'value': val,
                'FLD_code': fld_code_str,
                'tooltip': help_text
            }
            
            # Aggregate all metadata columns
            # We want to check ALL headers that might exist in the collected rows
            if meta_info:
                # Collect all column names found in the matched rows
                found_keys = set()
                for row in meta_info.values():
                    found_keys.update(row.keys())
                
                for key in found_keys:
                    if key is None: continue # Skip 'restkey' or unmatched columns
                    
                    values = []
                    # We iterate over fld_codes to preserve some order or logic?
                    # Or just iterate over meta_info items?
                    # The fld_codes list determines which rows are relevant.
                    for code in fld_codes:
                        if code in meta_info:
                            val_part = meta_info[code].get(key, '')
                            if val_part: 
                                if isinstance(val_part, list):
                                    values.append(",".join(map(str, val_part)))
                                else:
                                    values.append(str(val_part))
                    
                    if values:
                        # Join multiple values with semi-colon
                        # Avoid duplicating if same value exists? 
                        # Let's keep all to see distribution
                        csv_entry[key] = "; ".join(values)
            
            if 'csv_entries' not in state_container:
                state_container['csv_entries'] = []
            
            state_container['csv_entries'].append(csv_entry)

        return val

    elif type_obj.is_complex():
        label = f"**{element.local_name}**"
        
        # Try to get documentation for complex type
        c_help_lines = []
        c_docs = get_documentation(element)
        if not c_docs:
             c_docs = get_documentation(type_obj)
        
        if c_docs:
            # We can't put help on markdown, so we render an info box or caption if docs exist
            st.markdown(label)
            for d in c_docs:
                st.caption(f"ℹ️ {d}")
        else:
            st.markdown(label)
            
        st.caption(f"Path: `{current_path}`")
        
        group = type_obj.content
        if not group: 
            return None

        children_data = {}
        
        # Helper to process model groups (Sequence/Choice)
        def process_group(group_particle, parent_key, current_path, indent_level, cv, cd, md):
             group_data = {}
             
             # If it's a Choice with minOccurs >= 1, we must force a made selection
             if group_particle.model == 'choice' and group_particle.min_occurs >= 1:
                 # Get options
                 options = [p for p in group_particle.iter_model()]
                 # Create labels for options (using local_name if element, else 'Group')
                 option_labels = []
                 for opt in options:
                     if isinstance(opt, xmlschema.validators.XsdElement):
                         option_labels.append(opt.local_name)
                     else:
                         option_labels.append("Nested Group") # Simplified for now
                 
                 # Unique key for this choice
                 choice_key = f"{parent_key}_choice_{id(group_particle)}"
                 
                 st.markdown(f"{'  ' * indent_level}*Choose one required option:*")
                 # Check if we have a default choice in config? Not supported yet.
                 selected_label = st.radio("Select type:", option_labels, key=choice_key, horizontal=True, label_visibility="collapsed")
                 
                 # Find selected particle
                 selected_particle = None
                 for opt in options:
                     if isinstance(opt, xmlschema.validators.XsdElement) and opt.local_name == selected_label:
                         selected_particle = opt
                         break
                 
                 if selected_particle:
                      # Process the selected branch
                      if isinstance(selected_particle, xmlschema.validators.XsdElement):
                           with st.container():
                                col1, col2 = st.columns([0.5, 9.5])
                                with col2:
                                    # Recursive call
                                    val = render_input_fields(
                                        selected_particle, 
                                        selected_particle.type, 
                                        parent_key, 
                                        state_container, 
                                        current_path,
                                        cv, cd, md
                                    )
                                    group_data[selected_particle.name] = val
             
             # If Sequence or Optional Choice (though optional choice usually doesn't force input)
             else:
                 for particle in group_particle.iter_model():
                     if isinstance(particle, xmlschema.validators.XsdElement):
                         if particle.min_occurs >= 1:
                            with st.container():
                                col1, col2 = st.columns([0.5, 9.5])
                                with col2:
                                    child_val = render_input_fields(
                                        particle, 
                                        particle.type, 
                                        parent_key, 
                                        state_container, 
                                        current_path,
                                        cv, cd, md
                                    )
                                    if child_val is not None:
                                        group_data[particle.name] = child_val
                     
                     elif isinstance(particle, xmlschema.validators.XsdGroup):
                         if particle.min_occurs >= 1:
                             # Recurse for nested group
                             nested_data = process_group(particle, parent_key, current_path, indent_level, cv, cd, md)
                             group_data.update(nested_data)
                             
             return group_data

        # Start processing the top-level group
        # The top level content of a complex type is a Group (usually sequence)
        children_data = process_group(group, key, current_path, 0, config_visible, config_defaults, metadata)
        
        return children_data

def build_xml_element(element_name, xsd_type, form_data):
    """Recursively builds an ElementTree element from the dictionary form data."""
    tag = element_name
    elem = ET.Element(tag)
    
    if isinstance(form_data, dict):
        # Determine the order based on schema to ensure validity? 
        # For simplicity, we iterate over the form_data keys which were created in order.
        
        # We need to map simple names back to schema particles if possible, 
        # but here our keys in form_data are the fully qualified names (from element.name) 
        # or we stored them that way.
        
        # In render_input_fields for complex types, we returned a dict:
        # { particle.name : value }
        
        for child_tag, child_val in form_data.items():
            if child_val is None: continue # Should not happen for mandatory fields if UI works
            
            # Since child_val can be a string (simple) or dict (complex)
            if isinstance(child_val, (str, dict)):
                child_elem = build_xml_element_manual_tag(child_tag, child_val)
                elem.append(child_elem)
    
    elif isinstance(form_data, str):
        elem.text = form_data
        
    return elem

def build_xml_element_manual_tag(tag, content):
    elem = ET.Element(tag)
    if isinstance(content, dict):
        for child_tag, child_val in content.items():
            child_elem = build_xml_element_manual_tag(child_tag, child_val)
            elem.append(child_elem)
    else:
        elem.text = str(content)
    return elem

# --- Main App ---

schema, error_msg = load_schema()
metadata_csv, metadata_headers = load_eudamed_metadata()

if not schema:
    st.error(error_msg)
    st.stop()

# --- Product Group Selection ---
st.sidebar.header("Configuration")
# TODO: Scan directory for available YAML files to make this dynamic
product_groups = ["Lens", "ViscoHA", "ViscoMC", "Injector", "PILMA", "CTR"] 
# Default to "Lens" (Index 1 in the list ["None", "Lens", ...])
default_ix = 1 if "Lens" in product_groups else 0
selected_group = st.sidebar.selectbox("Select Product Group", ["None"] + product_groups, index=default_ix)

config_visible = None
config_defaults = None

if selected_group != "None":
    config_visible, config_defaults = load_config(selected_group)
    if config_visible or config_defaults:
        st.sidebar.success(f"Loaded configuration for {selected_group}")
    else:
        st.sidebar.warning(f"No specific configuration found for {selected_group}")


# Namespace handling
namespaces = {
    'device': 'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/v1',
    'basicudi': 'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/BasicUDI/v1',
    'udidi': 'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/UDIDI/v1',
    'commondi': 'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/CommonDevice/v1',
    'xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    'eudi': 'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/LegacyDevice/EUDI/v1',
    'eudididata': 'https://ec.europa.eu/tools/eudamed/dtx/datamodel/Entity/Device/LegacyDevice/EUDIData/v1'
}
for prefix, uri in namespaces.items():
    ET.register_namespace(prefix, uri)

# Device Configuration Type Selection
device_type_options = {
    "MDR Device (Regulation)": "MDRDevice",
    "Legacy Device (MDD/AIMDD)": "MDEUDevice",
    "IVDR Device": "IVDRDevice",
    "Legacy IVD": "IVDEUDevice"
}

st.sidebar.markdown("---")
# Default to MDR Device
selected_device_type_label = st.sidebar.selectbox("Select Device Type", list(device_type_options.keys()))
selected_root_element_name = device_type_options[selected_device_type_label]

# Find root definition
mdr_device_element = schema.elements.get(selected_root_element_name)
if not mdr_device_element:
    mdr_device_element = schema.elements.get(f"{{{namespaces['device']}}}{selected_root_element_name}")

if not mdr_device_element:
    st.error(f"Could not find {selected_root_element_name} element definition in schema.")
    st.stop()

mdr_device_type = mdr_device_element.type
basic_udi_def = None
udidi_data_def = None

# Logic to find the Basic UDI and UDI-DI Data parts based on naming conventions
# MDR: MDRBasicUDI, MDRUDIDIData
# Legacy: MDEUDI, MDEUData
# IVDR: IVDRBasicUDI, IVDRUDIDIData
# Legacy IVD: IVDEUDI, IVDEUData

for particle in mdr_device_type.content.iter_model():
    name = particle.name
    if 'BasicUDI' in name or 'EUDI' in name:
        basic_udi_def = particle
    elif 'UDIDIData' in name or 'EUData' in name:
        udidi_data_def = particle

if not basic_udi_def or not udidi_data_def:
    st.error(f"Structure mismatch for {selected_root_element_name}: Could not find Basic UDI or Data definitions.")
    st.stop()


# --- UI Layout ---

st.header(f"{selected_device_type_label} Configuration")
st.info("Fill in the mandatory fields for the Basic UDI. Min Occurs >= 1 fields only.")

# We use a distinct key prefix
basic_udi_path = f"{mdr_device_element.local_name}"
# Add selected_group to key prefix to ensure widgets refresh when configuration changes
basic_udi_key_prefix = f"root_{selected_group}_{selected_root_element_name}"

# Container for collecting data for CSV export
data_collection_container = {'csv_entries': []}

basic_udi_data = render_input_fields(
    basic_udi_def, 
    basic_udi_def.type, 
    basic_udi_key_prefix, 
    data_collection_container, 
    basic_udi_path, 
    config_visible, 
    config_defaults,
    metadata_csv
)

st.header(f"{selected_device_type_label} Data Entries")
st.info("Fill in the mandatory fields for the UDI-DI. You can add multiple entries.")

# Determins if multiple UDI-DIs are allowed (maxOccurs > 1 or unbounded)
max_occurs = getattr(udidi_data_def, 'max_occurs', 1)
is_multiple_allowed = max_occurs is None or max_occurs > 1

if is_multiple_allowed:
    col_count, col_dummy = st.columns([2, 8])
    with col_count:
        num_udis = st.number_input("Number of UDI-DI entries", min_value=1, max_value=10, value=1)
else:
    st.warning("This device type allows only 1 UDI-DI Data entry.")
    num_udis = 1

udidi_data_list = []
udidi_base_path = f"{mdr_device_element.local_name}"
for i in range(num_udis):
    st.subheader(f"UDI-DI Entry #{i+1}")
    st.markdown("---")
    # Pass unique parent key with group prefix
    group_key_prefix = f"root_{selected_group}_{selected_root_element_name}.udidi_{i}"
    udidi_data = render_input_fields(
        udidi_data_def, 
        udidi_data_def.type, 
        group_key_prefix, 
        data_collection_container, 
        udidi_base_path,
        config_visible,
        config_defaults,
        metadata_csv
    )
    udidi_data_list.append(udidi_data)

st.markdown("---")
# Action Buttons in columns
col_gen, col_export = st.columns([1, 1])

with col_gen:
    submitted = st.button("Generate XML", type="primary")

with col_export:
    # Prepare CSV Data
    csv_buffer = io.StringIO()
    
    # Define fields: Standard + All Metadata Headers (excluding duplicate Field ID)
    fieldnames = ['XMLPath', 'value', 'FLD_code', 'tooltip'] + metadata_headers
    
    writer = csv.DictWriter(csv_buffer, fieldnames=fieldnames, extrasaction='ignore')
    writer.writeheader()
    if 'csv_entries' in data_collection_container:
        writer.writerows(data_collection_container['csv_entries'])
    
    st.download_button(
        label="Export Data to CSV",
        data=csv_buffer.getvalue(),
        file_name="eudamed_data_export.csv",
        mime="text/csv"
    )

if submitted:
    st.success("Generating XML...")
    
    # Build Root
    root = ET.Element(mdr_device_element.name)
    
    # 1. Add Basic UDI
    # basic_udi_data contains the nested dict structure of values
    # We need to construct the elements. 
    # The render function returned the data relative to the CHILDREN of 'basic_udi_def'.
    # We need to wrap it in the basic_udi_def tag itself.
    
    if basic_udi_data:
        basic_udi_elem = build_xml_element_manual_tag(basic_udi_def.name, basic_udi_data)
        root.append(basic_udi_elem)
        
    # 2. Add UDI-DIs
    for udi_data in udidi_data_list:
        if udi_data:
             udidi_elem = build_xml_element_manual_tag(udidi_data_def.name, udi_data)
             root.append(udidi_elem)

    # Generate String
    # Note: ElementTree doesn't support pretty printing natively well in older versions, 
    # but valid XML is produced.
    xml_str = ET.tostring(root, encoding="utf-8", method="xml").decode("utf-8")
    
    # Add header manually as ET may omit it or make it simple
    final_xml = '<?xml version="1.0" encoding="utf-8"?>\n' + xml_str
    
    st.text_area("Generated XML", value=final_xml, height=400)
    
    # Validation
    st.subheader("Validation")
    
    # Save to temp file for validation
    temp_filename = "generated_eudamed_streamlit.xml"
    with open(temp_filename, "w", encoding="utf-8") as f:
        f.write(final_xml)
        
    try:
        schema.validate(temp_filename)
        st.success("✅ Validation Successful! The XML is valid against the schema.")
        
        with open(temp_filename, "rb") as f:
            st.download_button(
                label="Download XML",
                data=f,
                file_name="eudamed_device.xml",
                mime="application/xml"
            )
            
    except xmlschema.XMLSchemaValidationError as e:
        st.error(f"❌ Validation Failed:\n{e}")
