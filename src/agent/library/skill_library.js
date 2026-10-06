import { cosineSimilarity } from '../../utils/math.js';
import { getSkillDocs } from './index.js';
import { getCapabilityDocs } from './sdk_capabilities.js';

function queryCoverage(query, document) {
    const words = text => text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const queryWords = new Set(words(query));
    const documentWords = new Set(words(document));
    if (!queryWords.size) return 0;
    let matched = 0;
    for (const word of queryWords) if (documentWords.has(word)) matched++;
    return matched / queryWords.size;
}

export class SkillLibrary {
    constructor(agent,embedding_model) {
        this.agent = agent;
        this.embedding_model = embedding_model;
        this.skill_docs_embeddings = {};
        this.skill_docs = null;
        this.always_show_skills = ['skills.placeBlock', 'skills.wait', 'skills.breakBlockAt', 'skills.collectBlock', 'skills.craftRecipe', 'vision.lookAtPlayer', 'vision.lookAtPosition', 'vision.lookAtBlock']
    }
    async initSkillLibrary() {
        const skillDocs = [...getSkillDocs(), ...getCapabilityDocs()];
        this.skill_docs = skillDocs;
        if (this.embedding_model) {
            try {
                const embeddingPromises = skillDocs.map((doc) => {
                    return (async () => {
                        let func_name_desc = doc.split('\n').slice(0, 2).join('');
                        this.skill_docs_embeddings[doc] = await this.embedding_model.embed(func_name_desc);
                    })();
                });
                await Promise.all(embeddingPromises);
            } catch (error) {
                console.warn('Error with embedding model, using word-overlap instead.');
                this.embedding_model = null;
            }
        }
        this.always_show_skills_docs = {};
        for (const skillName of this.always_show_skills) {
            this.always_show_skills_docs[skillName] = this.skill_docs.find(doc => doc.includes(skillName));
        }
    }

    async getAllSkillDocs() {
        return this.skill_docs;
    }

    async getRelevantSkillDocs(message, select_num) {
        if(!message) // use filler message if none is provided
            message = '(no message)';
        let skill_doc_similarities = [];

        if (select_num === -1) {
            const docs = this.embedding_model ? Object.keys(this.skill_docs_embeddings) : this.skill_docs;
            skill_doc_similarities = docs
            .map(doc_key => ({
                doc_key,
                similarity_score: 0
            }));
        }
        else if (!this.embedding_model) {
            const docs = this.skill_docs;
            skill_doc_similarities = docs
                .map(doc_key => ({
                    doc_key,
                    similarity_score: queryCoverage(message, doc_key)
                }))
                .sort((a, b) => b.similarity_score - a.similarity_score);
        }
        else {
            let latest_message_embedding = await this.embedding_model.embed(message);
            skill_doc_similarities = Object.keys(this.skill_docs_embeddings)
            .map(doc_key => ({
                doc_key,
                similarity_score: cosineSimilarity(latest_message_embedding, this.skill_docs_embeddings[doc_key])
            }))
            .sort((a, b) => b.similarity_score - a.similarity_score);
        }

        let length = skill_doc_similarities.length;
        if (select_num === -1 || select_num > length) {
            select_num = length;
        }
        // Get initial docs from similarity scores
        let selected_docs = new Set(skill_doc_similarities.slice(0, select_num).map(doc => doc.doc_key));
        
        // Add always show docs
        Object.values(this.always_show_skills_docs).forEach(doc => {
            if (doc) {
                selected_docs.add(doc);
            }
        });
        
        let relevant_skill_docs = '#### RELEVANT CODE DOCS ###\nThe following functions are available to use:\n';
        relevant_skill_docs += Array.from(selected_docs).join('\n### ');

        console.log('Selected skill docs:', Array.from(selected_docs).map(doc => {
            const first_line_break = doc.indexOf('\n');
            return first_line_break > 0 ? doc.substring(0, first_line_break) : doc;
        }));
        return relevant_skill_docs;
    }
}
